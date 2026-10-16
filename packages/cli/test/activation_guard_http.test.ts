import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ProjectLock } from '@lorepack/backend-local';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { expect, it, vi } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { openStateStore } from '../src/services/builds.js';
import { startServing } from '../src/services/serving.js';
import { createActivateEndpoint } from '../src/services/studio-mutations.js';

it('returns the typed stale activation refusal after a real competing lock holder moves the pointer', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: guarded\nsources: [.]\n',
        'a.md': '# First\n',
      },
    },
    async (project) => {
      const config = loadConfig({ cwd: project.root });
      const first = await runBuild({ config, progress: new ProgressBus() });
      writeFileSync(join(project.root, 'a.md'), '# Second\n');
      const second = await runBuild({ config, progress: new ProgressBus() });
      await createActivateEndpoint(config)({ build: first.buildId });
      const port = await new Promise<number>((resolve, reject) => {
        const socket = createServer();
        socket.on('error', reject);
        socket.listen(0, '127.0.0.1', () => {
          const address = socket.address();
          if (address === null || typeof address === 'string') {
            socket.close();
            reject(new Error('Expected a TCP address.'));
            return;
          }
          socket.close(() => resolve(address.port));
        });
      });
      const server = await startServing({
        config,
        host: '127.0.0.1',
        port,
        studio: true,
        warn: () => {},
      });
      const directory = join(project.root, '.lore');
      const holder = new ProjectLock(join(directory, 'lock'));
      const state = openStateStore(directory);
      let spy: ReturnType<typeof vi.spyOn> | undefined;
      let pending: Promise<Response> | undefined;
      try {
        await holder.acquire();
        const waiting = Promise.withResolvers<void>();
        const acquire = ProjectLock.prototype.acquire;
        spy = vi.spyOn(ProjectLock.prototype, 'acquire').mockImplementation(function (
          this: ProjectLock,
        ) {
          waiting.resolve();
          return acquire.call(this);
        });
        const request = { build: second.buildId, expectActive: first.buildId };
        pending = fetch(`${server.url}/v1/builds/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: server.url },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(10_000),
        });
        await Promise.race([
          waiting.promise,
          pending.then(() => {
            throw new Error('Activation did not wait for the held project lock.');
          }),
        ]);
        state.activate(second.buildId);
        const competing = state.current();
        holder.release();
        const response = await pending;
        const body: unknown = await response.json();
        const receipt = { request, status: response.status, response: body };
        expect(response.status, JSON.stringify(receipt)).toBe(400);
        expect(body).toMatchObject({
          error: {
            code: 'LORE_E_INVALID_ARGUMENT',
            message: 'The active build changed while this confirmation was open.',
            remediation: expect.stringContaining(second.buildId),
          },
        });
        expect(state.current()).toEqual(competing);
        console.info('Controlled activation refusal:', JSON.stringify(receipt));
      } finally {
        holder.release();
        spy?.mockRestore();
        await pending?.catch(() => undefined);
        state.close();
        await server.close();
      }
    },
  );
}, 60_000);
