import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import {
  createLocalRuntimeBackend,
  LocalStateStore,
  stateMigrationsDirectory,
} from '@lorepack/backend-local';
import { type BuildId, type LoadedConfig, loadConfig, ProgressBus } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it, vi } from 'vitest';
import { runBuild } from '../src/services/build.js';
import {
  type RunningServer,
  SERVE_DEFAULTS,
  type ServingDependencies,
  startServing,
} from '../src/services/serving.js';

const BUILD_ID = `lore_${'a'.repeat(64)}` as BuildId;
const CONFIG = {
  projectRoot: '/tmp/lorepack-serving-startup',
  config: { name: 'demo' },
} as LoadedConfig;

async function closeListeners(listeners: readonly Server[]) {
  await Promise.all(
    listeners.map(
      (listener) =>
        new Promise<void>((resolve, reject) => {
          if (!listener.listening) return resolve();
          listener.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
}

async function occupyRange() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listeners: Server[] = [];
    let acquired = false;
    try {
      let first = 0;
      for (let offset = 0; offset < SERVE_DEFAULTS.attempts; offset += 1) {
        const listener = createServer((socket) => socket.destroy());
        listeners.push(listener);
        await new Promise<void>((resolve, reject) => {
          listener.once('error', reject);
          listener.listen({ host: '127.0.0.1', port: offset === 0 ? 0 : first + offset }, resolve);
        });
        const address = listener.address();
        if (address === null || typeof address === 'string')
          throw new Error('The fixture needs a real loopback TCP port.');
        if (offset === 0) first = address.port;
        if (first + SERVE_DEFAULTS.attempts - 1 > 65_535) break;
      }
      if (listeners.length === SERVE_DEFAULTS.attempts && listeners.every((s) => s.listening)) {
        acquired = true;
        return { first, listeners };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    } finally {
      if (!acquired) await closeListeners(listeners);
    }
  }
  throw new Error('Could not acquire a contiguous loopback port range in 20 fixture attempts.');
}

describe('serving startup cleanup', () => {
  it('closes the backend when binding every port fails', async () => {
    const close = vi.fn();
    const backend = {
      provider: { current: async () => ({ buildId: BUILD_ID, generation: 1 }) },
      close,
    } as unknown as ReturnType<NonNullable<ServingDependencies['createBackend']>>;
    const dependencies: ServingDependencies = {
      createBackend: vi.fn(() => backend),
      listen: vi.fn(async () => {
        throw new Error('no free port');
      }),
    };

    await expect(
      startServing({ config: CONFIG, host: '127.0.0.1', port: 4321, warn: vi.fn() }, dependencies),
    ).rejects.toThrow('no free port');
    expect(close).toHaveBeenCalledOnce();
  });

  it('cleans up a real occupied range and serves the same build after release, CORE41', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: occupied-ports\nsources: [docs]\n',
          'docs/policy.md': '# Policy\n\nPort conflict recovery remains readable.\n',
        },
      },
      async (project) => {
        const config = loadConfig({ cwd: project.root });
        const built = await runBuild({ config, progress: new ProgressBus() });
        const { first, listeners } = await occupyRange();
        let running: RunningServer | undefined;
        try {
          expect(listeners).toHaveLength(20);
          expect(listeners.every((listener) => listener.listening)).toBe(true);
          const backend = createLocalRuntimeBackend({ projectRoot: project.root });
          const close = vi.spyOn(backend, 'close');
          const message = `No free port between ${first} and ${first + SERVE_DEFAULTS.attempts - 1}.`;
          const remediation = 'Pass a different --port, or stop whatever is using this range.';
          try {
            await expect(
              startServing(
                { config, host: '127.0.0.1', port: first, warn: vi.fn() },
                { createBackend: () => backend },
              ).then((server) => {
                running = server;
                return server;
              }),
            ).rejects.toMatchObject({ code: 'LORE_E_INVALID_ARGUMENT', message, remediation });
            expect(close).toHaveBeenCalledOnce();
          } finally {
            const wasClosed = close.mock.calls.length > 0;
            close.mockRestore();
            if (!wasClosed && running === undefined) backend.close();
          }

          const binary = join(import.meta.dirname, '..', 'dist', 'public-entry.js');
          const argv = [
            binary,
            '--cwd',
            project.root,
            '--json',
            'serve',
            '--host',
            '127.0.0.1',
            '--port',
            String(first),
          ];
          const outcome = await new Promise<{
            code: string | number;
            killed: boolean;
            signal: NodeJS.Signals | null;
            stdout: string;
            stderr: string;
          }>((resolve) => {
            execFile(
              process.execPath,
              argv,
              { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' },
              (error, stdout, stderr) => {
                resolve({
                  code: error?.code ?? 0,
                  killed: error?.killed ?? false,
                  signal: error?.signal ?? null,
                  stdout,
                  stderr,
                });
              },
            );
          });
          console.info('CORE41 occupied-port binary receipt', JSON.stringify({ argv, ...outcome }));
          expect(typeof outcome.code).toBe('number');
          expect(outcome.code).not.toBe(0);
          expect(outcome.killed).toBe(false);
          expect(outcome.signal).toBeNull();
          expect(JSON.parse(outcome.stdout)).toMatchObject({
            error: { code: 'LORE_E_INVALID_ARGUMENT', message, remediation },
          });

          await closeListeners(listeners);
          expect(listeners.every((listener) => !listener.listening)).toBe(true);
          running = await startServing({ config, host: '127.0.0.1', port: first, warn: vi.fn() });
          expect(running.port).toBe(first);
          expect(running.buildId).toBe(built.buildId);
          const health = await fetch(`${running.url}/health`, { headers: { Connection: 'close' } });
          expect(health.status).toBe(200);
          expect(await health.json()).toMatchObject({ buildId: built.buildId });
          const response = await fetch(`${running.url}/v1/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Connection: 'close' },
            body: JSON.stringify({ query: 'Policy' }),
          });
          expect(response.status).toBe(200);
          const result = await response.json();
          expect(result).toMatchObject({ buildId: built.buildId });
          expect(JSON.stringify(result)).toContain('Port conflict recovery remains readable.');
          await running.close();
          running = undefined;
          const reopened = createLocalRuntimeBackend({ projectRoot: project.root });
          try {
            expect(await createRuntime(reopened).readSource({ path: 'policy.md' })).toMatchObject({
              buildId: built.buildId,
              text: expect.stringContaining('Port conflict recovery remains readable.'),
            });
          } finally {
            reopened.close();
          }
          const lore = join(project.root, '.lore');
          const state = LocalStateStore.open(lore, stateMigrationsDirectory());
          try {
            expect(state.current()?.buildId).toBe(built.buildId);
          } finally {
            state.close();
          }
          rmSync(lore, { recursive: true });
          expect(existsSync(lore)).toBe(false);
        } finally {
          try {
            await running?.close();
          } finally {
            await closeListeners(listeners);
          }
        }
      },
    );
  });
});
