import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { createCloudflareDeploymentTarget } from '@lorepack/deploy-cloudflare';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import {
  CORPUS_ID,
  createProjectedWorkerRuntimeFixture,
  PROJECT,
} from '../../deploy-cloudflare/test/projected-runtime-fixture.js';
import { LoreClient } from '../../sdk/src/index.js';
import { runBuild } from '../src/services/build.js';
import { startServing } from '../src/services/serving.js';

const execute = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'dist', 'public-entry.js');

it.each(['legacyzeta', 'oldtheta'])(
  'does not select historical-only evidence for %s without explicit history, issue699',
  async (task) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': `version: 1
name: current-only
sources: [.]
rules:
  - match: archived.md
    status: archived
  - match: replacement.md
    supersedes: [old.md]
  - match: draft.md
    status: draft
`,
          'archived.md': '# Legacy\n\nLegacyzeta permission no longer applies.\n',
          'old.md': '# Previous\n\nOldtheta instructions from the previous release.\n',
          'replacement.md': '# Current\n\nCurrent kappa instructions.\n',
          'draft.md': '# Proposal\n\nDrafteta proposed instructions.\n',
        },
      },
      async (project) => {
        const built = await runBuild({
          config: loadConfig({ cwd: project.root }),
          progress: new ProgressBus(),
        });
        const backend = createLocalRuntimeBackend({ projectRoot: project.root });
        try {
          const runtime = createRuntime(backend);
          const history = await runtime.contextForTask({ task, includeArchived: true });
          const historical = [...history.overview, ...history.selected];
          expect(historical.length).toBeGreaterThan(0);
          expect(historical.flatMap((item) => item.labels)).toContain(
            task === 'legacyzeta' ? 'archived' : 'superseded',
          );
          const current = await runtime.contextForTask({ task });
          expect(current.buildId).toBe(built.buildId);
          expect([...current.overview, ...current.selected]).toEqual([]);
          expect(current.alternatives).toEqual([]);
          expect(current.omitted.map((item) => item.reason)).toContain(
            task === 'legacyzeta' ? 'archived' : 'superseded',
          );
          const draft = await runtime.contextForTask({ task: 'drafteta' });
          expect([...draft.overview, ...draft.selected].flatMap((item) => item.labels)).toContain(
            'draft',
          );
          const exported = await execute(
            process.execPath,
            [BIN, '--cwd', project.root, 'export', '--task', task, '--format', 'json'],
            { timeout: 30_000 },
          );
          const currentExport = JSON.parse(exported.stdout);
          expect([
            ...currentExport.overview,
            ...currentExport.selected,
            ...currentExport.alternatives,
          ]).toEqual([]);
          const expanded = await execute(
            process.execPath,
            [
              BIN,
              '--cwd',
              project.root,
              'export',
              '--task',
              task,
              '--format',
              'json',
              '--include-archived',
            ],
            { timeout: 30_000 },
          );
          const historyExport = JSON.parse(expanded.stdout);
          expect([...historyExport.overview, ...historyExport.selected].length).toBeGreaterThan(0);
          const server = await startServing({
            config: loadConfig({ cwd: project.root }),
            host: '127.0.0.1',
            port: 47_992,
            warn: () => {},
          });
          try {
            const client = new LoreClient({ baseUrl: server.url });
            const currentHttp = await client.contextForTask({ task });
            expect([
              ...currentHttp.overview,
              ...currentHttp.selected,
              ...currentHttp.alternatives,
            ]).toEqual([]);
            const historicalHttp = await client.contextForTask({ task, includeArchived: true });
            expect([...historicalHttp.overview, ...historicalHttp.selected].length).toBeGreaterThan(
              0,
            );
            for (const includeArchived of [false, true]) {
              const response = await fetch(`${server.url}/mcp`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json, text/event-stream',
                },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'tools/call',
                  params: { name: 'lore_context_for_task', arguments: { task, includeArchived } },
                }),
              });
              expect(response.status).toBe(200);
              const text = await response.text();
              const historicalText =
                task === 'legacyzeta' ? 'Legacyzeta permission' : 'Oldtheta instructions';
              if (includeArchived) expect(text).toContain(historicalText);
              else expect(text).not.toContain(historicalText);
            }
          } finally {
            await server.close();
          }
          const projected = await createProjectedWorkerRuntimeFixture();
          try {
            const target = createCloudflareDeploymentTarget({
              corpusId: CORPUS_ID,
              projectId: PROJECT,
              endpoint: 'https://example.workers.dev/mcp',
              catalogDb: projected.projection,
              objects: projected.bucket,
            });
            const plan = await target.plan({
              corpusId: CORPUS_ID,
              projectName: PROJECT,
              buildId: built.buildId,
              buildDirectory: join(project.root, '.lore/builds', built.buildId),
              buildCapabilities: ['lexical-search', 'structured-context'],
            });
            const receipt = await target.apply(plan);
            expect(await target.verify(receipt)).toMatchObject({
              search: 'passed',
              sourceRead: 'passed',
            });
            await target.activate(receipt);
            const remoteCurrent = await projected.runtime.contextForTask({ task });
            expect(remoteCurrent.buildId).toBe(built.buildId);
            expect([
              ...remoteCurrent.overview,
              ...remoteCurrent.selected,
              ...remoteCurrent.alternatives,
            ]).toEqual([]);
            const remoteHistory = await projected.runtime.contextForTask({
              task,
              includeArchived: true,
            });
            expect(
              [...remoteHistory.overview, ...remoteHistory.selected].flatMap((item) => item.labels),
            ).toContain(task === 'legacyzeta' ? 'archived' : 'superseded');
          } finally {
            await projected.close();
          }
        } finally {
          backend.close();
        }
      },
    );
  },
);
