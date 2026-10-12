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

it('identifies resolved execution independently from immutable content and observations, issue693', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: execution\nsources: [docs]\n',
        'docs/recovery.md': '# Recovery\n\nRestore the checkpoint before resuming the worker.\n',
      },
    },
    async (project) => {
      const built = await runBuild({
        config: loadConfig({ cwd: project.root }),
        progress: new ProgressBus(),
      });
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      try {
        const runtime = createRuntime({ ...backend, freshness: async () => 'clean' });
        const first = await runtime.contextForTask({ task: 'recovery' });
        expect(first.execution.policy.visibility).toMatchObject({
          version: 2,
          default: 'current-only',
          includeArchived: false,
        });
        const identity = (bundle: unknown) =>
          (bundle as { execution: { policyId: string; selectionId: string } }).execution;
        expect(identity(first).policyId).toMatch(/^policy_[a-f0-9]{64}$/);
        expect(identity(first).selectionId).toMatch(/^selection_[a-f0-9]{64}$/);
        const explicit = await runtime.contextForTask({
          task: 'recovery',
          profile: 'agent',
          budget: 12_000,
          includeArchived: false,
          buildId: built.buildId,
        });
        expect(identity(explicit)).toEqual(identity(first));
        const observed = await createRuntime({
          ...backend,
          freshness: async () => 'dirty',
        }).contextForTask({ task: 'recovery' });
        expect(observed.sourceState).toBe('dirty');
        expect(identity(observed)).toEqual(identity(first));
        const budget = await runtime.contextForTask({ task: 'recovery', budget: 16_000 });
        expect(budget.buildId).toBe(built.buildId);
        expect(identity(budget).policyId).not.toBe(identity(first).policyId);
        const history = await runtime.contextForTask({ task: 'recovery', includeArchived: true });
        expect(history.buildId).toBe(built.buildId);
        expect(identity(history).policyId).not.toBe(identity(first).policyId);
        const execute = promisify(execFile);
        const bin = join(import.meta.dirname, '..', 'dist', 'public-entry.js');
        const args = [
          bin,
          '--cwd',
          project.root,
          'export',
          '--task',
          'recovery',
          '--profile',
          'agent',
        ];
        const json = await execute(process.execPath, [...args, '--format', 'json']);
        expect(JSON.parse(json.stdout).execution).toEqual(first.execution);
        const markdown = await execute(process.execPath, args);
        expect(markdown.stdout).toContain(first.execution.policyId);
        expect(markdown.stdout).toContain(first.execution.selectionId);
        const server = await startServing({
          config: loadConfig({ cwd: project.root }),
          host: '127.0.0.1',
          port: 47_994,
          warn: () => {},
        });
        try {
          const response = await new LoreClient({ baseUrl: server.url }).contextForTask({
            task: 'recovery',
          });
          expect(response.execution).toEqual(first.execution);
          const mcp = await fetch(`${server.url}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'lore_context_for_task', arguments: { task: 'recovery' } },
            }),
          });
          expect(mcp.status).toBe(200);
          const emitted = await mcp.text();
          expect(emitted).toContain(first.execution.policyId);
          expect(emitted).toContain(first.execution.selectionId);
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
          await target.verify(receipt);
          await target.activate(receipt);
          const remote = await projected.runtime.contextForTask({ task: 'recovery' });
          expect(remote.execution.policyId).toBe(first.execution.policyId);
          expect(remote.execution.selection.buildId).toBe(first.buildId);
          expect(remote.execution.selection.corpusId).toBe(remote.corpusId);
          expect(remote.execution.selection.namespaceId).toBe(remote.namespaceId);
          expect(remote.execution.selectionId).not.toBe(first.execution.selectionId);
        } finally {
          await projected.close();
        }
        const task = await runtime.contextForTask({ task: 'worker' });
        expect(identity(task).policyId).toBe(identity(first).policyId);
        expect(identity(task).selectionId).not.toBe(identity(first).selectionId);
      } finally {
        backend.close();
      }
    },
  );
});
