import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { contextBundleSchema, loadConfig, ProgressBus } from '@lorepack/core';
import { createCloudflareDeploymentTarget } from '@lorepack/deploy-cloudflare';
import { createMcpServer } from '@lorepack/mcp';
import { createApiApp, createRuntime } from '@lorepack/runtime';
import { inlineString, makeXlsx, number, row, withTempProject } from '@lorepack/test-support';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import {
  CORPUS_ID,
  createProjectedWorkerRuntimeFixture,
  PROJECT,
} from '../../deploy-cloudflare/test/projected-runtime-fixture.js';
import { LoreClient } from '../../sdk/src/index.js';
import { runBuild } from '../src/services/build.js';

const execute = promisify(execFile);
const CONTEXT_DEFAULTS = { allowUnsupportedBudget: false, includeArchived: false };
const BINARY = join(import.meta.dirname, '../dist/public-entry.js');

it.each(['http', 'mcp', 'json', 'markdown'])(
  'discovers a rate matrix through actual %s context, issue429',
  async (surface) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: table-context\nsources: [.]\n',
          'rate_matrix.csv': 'region,hourly_rate\nprivate-row-sentinel,125\n',
          'inventory.csv': 'sku,quantity\nprivate-inventory-sentinel,7\n',
        },
      },
      async (project) => {
        const built = await runBuild({
          config: loadConfig({ cwd: project.root }),
          progress: new ProgressBus(),
        });
        if (surface === 'json' || surface === 'markdown') {
          const { stdout } = await execute(process.execPath, [
            BINARY,
            '--cwd',
            project.root,
            'export',
            '--task',
            'rate matrix',
            '--format',
            surface === 'json' ? 'json' : 'markdown',
          ]);
          if (surface === 'markdown') {
            expect(stdout).toContain('## Tables');
            expect(stdout).toContain('table-context:rate_matrix.csv#table');
            expect(stdout).toContain(built.buildId);
            expect(stdout).not.toContain('private-row-sentinel');
            return;
          }
          const bundle = contextBundleSchema.parse(JSON.parse(stdout));
          expect(JSON.stringify(bundle)).not.toContain('private-row-sentinel');
          expect(bundle.tables).toHaveLength(1);
          expect(bundle.tables[0]).toMatchObject({
            tableId: 'table-context:rate_matrix.csv#table',
            locator: { relativePath: 'rate_matrix.csv' },
            schemaReference: {
              buildId: built.buildId,
              tableId: 'table-context:rate_matrix.csv#table',
            },
          });
          return;
        }
        const backend = createLocalRuntimeBackend({ projectRoot: project.root });
        try {
          const runtime = createRuntime(backend);
          let payload: unknown;
          if (surface === 'http') {
            const response = await createApiApp({
              runtime,
              currentBuild: () => backend.provider.current(),
            }).request('/v1/context', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ task: 'rate matrix' }),
            });
            expect(response.status).toBe(200);
            payload = await response.json();
          } else {
            const server = createMcpServer({ runtime });
            const client = new Client({ name: 'table-context-test', version: '1.0.0' });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            try {
              await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
              const response = await client.callTool({
                name: 'lore_context_for_task',
                arguments: { task: 'rate matrix' },
              });
              expect(response.isError).not.toBe(true);
              payload = response.structuredContent;
            } finally {
              await client.close();
              await server.close();
            }
          }
          const bundle = contextBundleSchema.parse(payload);
          expect(JSON.stringify(bundle)).not.toContain('private-row-sentinel');
          expect(bundle.tables).toHaveLength(1);
          expect(bundle.tables[0]).toMatchObject({
            tableId: 'table-context:rate_matrix.csv#table',
            locator: { relativePath: 'rate_matrix.csv' },
            schemaReference: {
              buildId: built.buildId,
              tableId: 'table-context:rate_matrix.csv#table',
            },
          });
          expect(JSON.stringify(bundle.tables)).not.toContain('private-row-sentinel');
          const reference = bundle.tables[0];
          if (reference === undefined) throw new Error('Expected the rate matrix reference.');
          const app = createApiApp({ runtime, currentBuild: () => backend.provider.current() });
          const pinned = new LoreClient({
            baseUrl: 'http://table-context.test',
            buildId: reference.schemaReference.buildId,
            fetch: async (input, init) => app.request(new Request(input, init)),
          });
          const schema = await pinned.describeTable(reference.schemaReference.tableId);
          expect(schema.buildId).toBe(built.buildId);
          expect(schema.locator).toEqual(reference.locator);
          expect(schema.columns.map((column) => column.name)).toEqual(['region', 'hourly_rate']);

          expect(bundle.citations).toContainEqual(
            expect.objectContaining({ relativePath: 'rate_matrix.csv' }),
          );
        } finally {
          backend.close();
        }
      },
    );
  },
);

it.each(['local', 'projected'])(
  'keeps table visibility, filters and schema reads consistent on %s, issue429',
  async (adapter) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': `version: 1
name: contracted
sources: [.]
rules:
  - match: archived.csv
    status: archived
  - match: draft.csv
    status: draft
  - match: rates.csv
    supersedes: [old.csv]
`,
          'rates.csv': 'hourly_rate,region\n125,private-active-row\n',
          'archived.csv': 'hourly_rate,legacy\n80,private-archived-row\n',
          'draft.csv': 'hourly_rate,proposal\n140,private-draft-row\n',
          'old.csv': 'hourly_rate,previous\n100,private-old-row\n',
        },
      },
      async (project) => {
        const built = await runBuild({
          config: loadConfig({ cwd: project.root }),
          progress: new ProgressBus(),
        });
        const backend = createLocalRuntimeBackend({ projectRoot: project.root });
        const projected =
          adapter === 'projected' ? await createProjectedWorkerRuntimeFixture() : undefined;
        try {
          if (projected !== undefined) {
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
              buildCapabilities: ['lexical-search', 'structured-context', 'table-query'],
            });
            const receipt = await target.apply(plan);
            expect(await target.verify(receipt)).toMatchObject({
              search: 'passed',
              sourceRead: 'passed',
            });
            await target.activate(receipt);
          }
          const runtime = projected?.runtime ?? createRuntime(backend);
          const current = await runtime.contextForTask({
            ...CONTEXT_DEFAULTS,
            task: 'hourly_rate',
          });
          expect(current.tables.map((table) => table.locator.relativePath).sort()).toEqual([
            'draft.csv',
            'rates.csv',
          ]);
          expect(
            current.tables.find((table) => table.locator.relativePath === 'draft.csv')?.labels,
          ).toContain('draft');
          expect(JSON.stringify(current)).not.toContain('private-');
          const expanded = await runtime.contextForTask({
            ...CONTEXT_DEFAULTS,
            task: 'hourly_rate',
            includeArchived: true,
          });
          expect(expanded.tables).toHaveLength(4);
          expect(
            expanded.tables.find((table) => table.locator.relativePath === 'archived.csv')?.labels,
          ).toContain('archived');
          expect(
            expanded.tables.find((table) => table.locator.relativePath === 'old.csv')?.labels,
          ).toContain('superseded');
          for (const filters of [
            [{ kind: 'path' as const, value: 'rates.csv' }],
            [{ kind: 'status' as const, value: 'active' }],
          ]) {
            const filtered = await runtime.contextForTask({
              ...CONTEXT_DEFAULTS,
              task: 'hourly_rate',
              filters,
            });
            expect(filtered.tables.map((table) => table.locator.relativePath)).toEqual([
              'rates.csv',
            ]);
          }
          const excluded = await runtime.contextForTask({
            ...CONTEXT_DEFAULTS,
            task: 'hourly_rate',
            filters: [{ kind: 'type', value: 'md' }],
          });
          expect(excluded.tables).toEqual([]);
          const reference = current.tables.find(
            (table) => table.locator.relativePath === 'rates.csv',
          );
          expect(reference).toBeDefined();
          if (reference === undefined)
            throw new Error('Expected the active rate schema reference.');
          const schema = await runtime.describeTable(reference.schemaReference.tableId, {
            buildId: reference.schemaReference.buildId,
          });
          expect(schema.locator).toEqual(reference.locator);
          expect(schema.columns.map((column) => column.name)).toEqual(['hourly_rate', 'region']);
          expect(current.buildId).toBe(built.buildId);
          expect(reference.schemaReference.buildId).toBe(built.buildId);
        } finally {
          backend.close();
          await projected?.close();
        }
      },
    );
  },
);

it('selects only a matching workbook sheet and keeps its schema pinned after activation, issue429', async () => {
  await withTempProject(
    { files: { 'lore.yaml': 'version: 1\nname: sheets\nsources: [.]\n' } },
    async (project) => {
      writeFileSync(
        project.path('pricing.xlsx'),
        await makeXlsx({
          sheets: [
            {
              name: 'Rate matrix',
              rows:
                row(1, [inlineString('A1', 'region'), inlineString('B1', 'hourly_rate')]) +
                row(2, [inlineString('A2', 'private-rate-row'), number('B2', 125)]),
            },
            {
              name: 'Inventory',
              rows:
                row(1, [inlineString('A1', 'sku'), inlineString('B1', 'quantity')]) +
                row(2, [inlineString('A2', 'private-stock-row'), number('B2', 7)]),
            },
          ],
        }),
      );
      const config = loadConfig({ cwd: project.root });
      const first = await runBuild({ config, progress: new ProgressBus() });
      project.write('new.md', '# New release\n\nA new document changes the build.\n');
      const second = await runBuild({ config, progress: new ProgressBus() });
      expect(second.buildId).not.toBe(first.buildId);
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      try {
        const runtime = createRuntime(backend);
        const bundle = await runtime.contextForTask({
          ...CONTEXT_DEFAULTS,
          task: 'hourly_rate',
          buildId: first.buildId,
        });
        expect(bundle.tables).toHaveLength(1);
        expect(bundle.tables[0]).toMatchObject({
          locator: { sheet: 'Rate matrix', cellRange: 'A1:B2' },
          schemaReference: { buildId: first.buildId },
        });
        expect(JSON.stringify(bundle)).not.toContain('private-');
        const reference = bundle.tables[0];
        if (reference === undefined) throw new Error('Expected a workbook schema reference.');
        const schema = await runtime.describeTable(reference.schemaReference.tableId, {
          buildId: reference.schemaReference.buildId,
        });
        expect(schema.buildId).toBe(first.buildId);
        expect(schema.locator).toEqual(reference.locator);
      } finally {
        backend.close();
      }
    },
  );
});
