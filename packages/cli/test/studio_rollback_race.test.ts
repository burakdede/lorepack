import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LocalStateStore,
  type LockOptions,
  stateMigrationsDirectory,
} from '@lorepack/backend-local';
import { loadConfig, loadProjectConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it, vi } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { createRollbackEndpoint } from '../src/services/studio-mutations.js';

const contention = vi.hoisted(() => ({ onWait: undefined as (() => void) | undefined }));

vi.mock('@lorepack/backend-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lorepack/backend-local')>();
  return {
    ...actual,
    ProjectLock: class extends actual.ProjectLock {
      constructor(path: string, options: LockOptions = {}) {
        super(path, {
          ...options,
          onWait(owner) {
            options.onWait?.(owner);
            contention.onWait?.();
          },
        });
      }
    },
  };
});

const BACKEND = new URL('../../backend-local/dist/index.js', import.meta.url).href;
const PEER = `
  import { LocalStateStore, ProjectLock, stateMigrationsDirectory } from ${JSON.stringify(BACKEND)};
  import { join } from 'node:path';
  const directory = process.argv[1];
  const target = process.argv[2];
  const lock = new ProjectLock(join(directory, 'lock'));
  await lock.acquire();
  process.stdout.write('held\\n');
  process.stdin.once('data', () => {
    const state = LocalStateStore.open(directory, stateMigrationsDirectory());
    try {
      if (target !== 'unchanged') state.activate(target);
      process.stdout.write(JSON.stringify(state.current()) + '\\n');
    } finally {
      state.close();
      lock.release();
    }
  });
`;

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The lock checkpoint was not reached.')), 10_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function holder(directory: string, target: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', PEER, directory, target], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  const ready = Promise.withResolvers<void>();
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes('held\n')) ready.resolve();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.once('error', ready.reject);
  const done = new Promise<number | null>((resolve) => {
    child.once('close', (code) => {
      if (!output.includes('held\n'))
        ready.reject(new Error(`Peer stopped before locking: ${stderr}`));
      resolve(code);
    });
  });
  return { child, ready: ready.promise, done, output: () => output, stderr: () => stderr };
}

async function builds(root: string) {
  const first = await runBuild({ config: loadConfig({ cwd: root }), progress: new ProgressBus() });
  writeFileSync(join(root, 'a.md'), '# Second\n');
  const second = await runBuild({ config: loadConfig({ cwd: root }), progress: new ProgressBus() });
  writeFileSync(join(root, 'a.md'), '# Third\n');
  const third = await runBuild({ config: loadConfig({ cwd: root }), progress: new ProgressBus() });
  return { first: first.buildId, second: second.buildId, third: third.buildId };
}

describe('Studio rollback confirmation under a real contended lock', () => {
  it.each(['first', 'second', 'unchanged'] as const)(
    'rechecks the target after the lock holder selects %s',
    async (selected) => {
      await withTempProject(
        { files: { 'lore.yaml': 'version: 1\nname: p\nsources: [.]\n', 'a.md': '# First\n' } },
        async (project) => {
          const ids = await builds(project.root);
          const directory = join(project.root, '.lore');
          const state = LocalStateStore.open(directory, stateMigrationsDirectory());
          const before = state.current();
          expect(before?.buildId).toBe(ids.third);
          const peer = holder(directory, selected === 'unchanged' ? selected : ids[selected]);
          let result: Promise<unknown> | undefined;
          try {
            await within(peer.ready);
            const waiting = Promise.withResolvers<void>();
            contention.onWait = waiting.resolve;
            result = createRollbackEndpoint(loadProjectConfig({ cwd: project.root }))({
              expect: ids.second,
            }).then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
            await within(waiting.promise);
            peer.child.stdin.end('activate\n');
            expect(await within(peer.done), peer.stderr()).toBe(0);
            const moved = JSON.parse(peer.output().trim().split('\n').at(-1) ?? 'null') as {
              buildId: string;
              generation: number;
            };
            const outcome = (await within(result)) as { error?: unknown; value?: unknown };
            if (selected === 'unchanged') {
              expect(outcome).toEqual({
                value: {
                  buildId: ids.second,
                  generation: (before?.generation ?? 0) + 1,
                  changed: true,
                },
              });
              expect(state.current()?.buildId).toBe(ids.second);
            } else {
              expect(state.current()).toEqual(moved);
              expect(outcome.error).toMatchObject({ code: 'LORE_E_INVALID_ARGUMENT' });
              expect(moved.buildId).toBe(ids[selected]);
            }
          } finally {
            contention.onWait = undefined;
            if (peer.child.exitCode === null && peer.child.signalCode === null)
              peer.child.kill('SIGKILL');
            await peer.done;
            if (result !== undefined) await result;
            state.close();
          }
        },
      );
    },
    30_000,
  );
});
