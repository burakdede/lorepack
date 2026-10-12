import { execFile, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import type { BuildId } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'dist', 'public-entry.js');

it('retains an idle catalog until its owner closes after external activation, issue 439', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: idle\nsources:\n  - docs\n',
        'docs/guide.md': '# Original\n\nOriginal body.\n',
      },
    },
    async (project) => {
      const cli = (args: string[]) =>
        execute(process.execPath, [BIN, '--cwd', project.root, '--json', ...args], {
          timeout: 30_000,
        });
      const first = JSON.parse((await cli(['build'])).stdout).buildId as string;
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      try {
        expect((await createRuntime(backend).readSource({ path: 'guide.md' })).text).toContain(
          'Original body',
        );
        writeFileSync(join(project.root, 'docs/guide.md'), '# Replacement\n\nReplacement body.\n');
        await cli(['build']);
        expect(JSON.parse((await cli(['prune', '--keep', '0', '--yes'])).stdout).keep).toContain(
          first,
        );
      } finally {
        backend.close();
      }
      expect(JSON.parse((await cli(['prune', '--keep', '0', '--yes'])).stdout).remove).toContain(
        first,
      );
    },
  );
}, 120_000);

it('preserves a separate live reader and reclaims its reference after abrupt process death, issue 439', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: crash\nsources:\n  - docs\n',
        'docs/guide.md': '# Original\n\nOriginal body.\n',
      },
    },
    async (project) => {
      const cli = (args: string[]) =>
        execute(process.execPath, [BIN, '--cwd', project.root, '--json', ...args], {
          timeout: 30_000,
        });
      const first = JSON.parse((await cli(['build'])).stdout).buildId as string;
      const module = pathToFileURL(
        join(import.meta.dirname, '../../backend-local/dist/index.js'),
      ).href;
      const code = `const { createLocalRuntimeBackend } = await import(${JSON.stringify(module)}); const backend = createLocalRuntimeBackend({ projectRoot: process.argv[1] }); const handle = await backend.provider.acquire(); process.on('message', () => {}); process.send({ buildId: handle.buildId });`;
      const child = spawn(process.execPath, ['--input-type=module', '--eval', code, project.root], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let diagnostics = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        diagnostics += chunk.toString();
      });
      try {
        const captured = await new Promise<unknown>((resolve, reject) => {
          child.once('message', resolve);
          child.once('exit', () =>
            reject(new Error(`Reader exited before acquisition: ${diagnostics}`)),
          );
        });
        expect(captured).toEqual({ buildId: first });
        writeFileSync(join(project.root, 'docs/guide.md'), '# Replacement\n\nReplacement body.\n');
        const second = JSON.parse((await cli(['build'])).stdout).buildId as string;
        expect(JSON.parse((await cli(['prune', '--keep', '0', '--yes'])).stdout).keep).toContain(
          first,
        );
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        });
        expect(JSON.parse((await cli(['prune', '--keep', '0', '--yes'])).stdout).remove).toContain(
          first,
        );
        expect(JSON.parse((await cli(['search', 'replacement'])).stdout)).toMatchObject({
          buildId: second,
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => {
            child.once('exit', () => resolve());
            child.kill('SIGKILL');
          });
        }
      }
    },
  );
}, 120_000);

it('keeps 200 captured A source reads alive across B activation and separate-process prune, issue 439', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: retention\nsources:\n  - docs\n',
        'docs/guide.md': '# Recovery\n\nCheckpoint instructions for held readers.\n',
        'docs/shared.md': '# Common policy\n\nShared permission applies.\n',
      },
    },
    async (project) => {
      const cli = async (args: string[]) =>
        execute(process.execPath, [BIN, '--cwd', project.root, '--json', ...args], {
          timeout: 30_000,
        });
      const first = JSON.parse((await cli(['build'])).stdout).buildId as BuildId;
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      expect((await createRuntime(backend).readSource({ path: 'guide.md' })).text).toContain(
        'Checkpoint instructions',
      );
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: () => void;
      const captured = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let reached = 0;
      const runtime = createRuntime({
        ...backend,
        open: async (handle) => {
          const scope = await backend.open(handle);
          if (handle.buildId === first) {
            reached += 1;
            if (reached === 200) ready();
            await gate;
          }
          return scope;
        },
      });
      const reads = Promise.allSettled(
        Array.from({ length: 200 }, () => runtime.readSource({ path: 'guide.md' })),
      );
      try {
        await captured;
        writeFileSync(
          join(project.root, 'docs/guide.md'),
          '# Recovery\n\nReplacement worker instructions.\n',
        );
        const second = JSON.parse((await cli(['build'])).stdout).buildId as BuildId;
        expect(second).not.toBe(first);
        const retained = JSON.parse((await cli(['prune', '--keep', '0', '--yes'])).stdout) as {
          keep: string[];
          protectedReads: unknown[];
        };
        expect(retained.keep).toContain(first);
        expect(retained.protectedReads).toContainEqual({ buildId: first, readers: 200 });
        expect((await createRuntime(backend).describeBuild()).buildId).toBe(second);
        expect((await createRuntime(backend).readSource({ path: 'guide.md' })).text).toContain(
          'Replacement worker',
        );
        release();
        const outcomes = await reads;
        const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
        const reasons = [...new Set(failures.map((outcome) => String(outcome.reason)))];
        expect(failures, JSON.stringify(reasons)).toHaveLength(0);
        for (const outcome of outcomes) {
          if (outcome.status !== 'fulfilled') throw new Error('A captured read failed.');
          expect(outcome.value.buildId).toBe(first);
          expect(outcome.value.text).toContain('Checkpoint instructions');
          expect(outcome.value.text).not.toContain('Replacement worker');
        }
        expect((await runtime.describeBuild()).buildId).toBe(second);
        const reclaimed = JSON.parse((await cli(['prune', '--keep', '0', '--yes'])).stdout) as {
          remove: string[];
        };
        expect(reclaimed.remove).toContain(first);
        const shared = await runtime.readSource({ path: 'shared.md' });
        expect(shared.buildId).toBe(second);
        expect(shared.text).toContain('Shared permission applies');
      } finally {
        release();
        await reads;
        backend.close();
      }
    },
  );
}, 120_000);
