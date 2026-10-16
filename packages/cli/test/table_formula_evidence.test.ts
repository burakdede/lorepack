import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { createCloudflareDeploymentTarget } from '@lorepack/deploy-cloudflare';
import { createMcpServer } from '@lorepack/mcp';
import { createApiApp, createRuntime } from '@lorepack/runtime';
import {
  formula,
  inlineString,
  makeXlsx,
  number,
  row,
  withTempProject,
} from '@lorepack/test-support';
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

it.each(['local', 'projected'])(
  'distinguishes cached formula cells and table conversion warnings on %s, issue430',
  async (adapter) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: contracted\nsources: [.]\n',
          'values.csv': 'quantity,formula_text\n1,=1+1\n',
        },
      },
      async (project) => {
        writeFileSync(
          project.path('rates.xlsx'),
          await makeXlsx({
            sheets: [
              {
                name: 'Rates',
                rows:
                  row(1, [
                    inlineString('A1', 'quantity'),
                    inlineString('B1', 'amount'),
                    inlineString('C1', 'computed'),
                    inlineString('D1', 'notes'),
                    inlineString('E1', 'copy'),
                  ]) +
                  row(2, [
                    number('A2', 2),
                    number('B2', 3),
                    formula('C2', 'A2+B2', 999),
                    inlineString('D2', 'Merged note'),
                  ]),
                merges: ['D2:E2'],
              },
            ],
          }),
        );
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
          const tables = await runtime.listTables();
          const matrix = tables.tables.find((table) => table.name === 'Rates');
          if (matrix === undefined) throw new Error('Expected the actual workbook table.');
          const schema = await runtime.describeTable(matrix.tableId, { buildId: built.buildId });
          expect(schema.sample[0]?.computed).toBe(999);
          expect(schema.locator).toMatchObject({
            relativePath: 'rates.xlsx',
            sheet: 'Rates',
            cellRange: 'A1:E2',
          });
          expect(schema.columns.find((column) => column.name === 'computed')).toMatchObject({
            formula: 'present',
          });
          expect(schema.columns.find((column) => column.name === 'amount')).toMatchObject({
            formula: 'absent',
          });
          expect(schema).toMatchObject({
            conversionWarnings: expect.arrayContaining([
              expect.objectContaining({
                code: 'xlsx-merged-cells',
                message: expect.stringContaining('top-left'),
              }),
            ]),
          });
          const csv = tables.tables.find((table) => table.name === 'values');
          if (csv === undefined) throw new Error('Expected the actual CSV table.');
          const plain = await runtime.describeTable(csv.tableId, { buildId: built.buildId });
          expect(plain.sample[0]?.formula_text).toBe('=1+1');
          expect(plain.columns).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: 'formula_text', formula: 'absent' }),
              expect.objectContaining({ name: 'quantity', formula: 'absent' }),
            ]),
          );
          expect(plain).toMatchObject({ conversionWarnings: [] });
          const app = createApiApp({ runtime, currentBuild: () => backend.provider.current() });
          const sdk = new LoreClient({
            baseUrl: 'http://formula.test',
            buildId: built.buildId,
            fetch: async (input, init) => app.request(new Request(input, init)),
          });
          expect(await sdk.describeTable(matrix.tableId)).toEqual(schema);
          const server = createMcpServer({ runtime });
          const client = new Client({ name: 'formula-evidence-test', version: '1.0.0' });
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          try {
            await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
            const response = await client.callTool({
              name: 'lore_describe_table',
              arguments: { tableId: matrix.tableId, buildId: built.buildId },
            });
            expect(response.isError).not.toBe(true);
            expect(response.structuredContent).toEqual(schema);
          } finally {
            await client.close();
            await server.close();
          }
          if (adapter === 'local') {
            const execute = promisify(execFile);
            const binary = join(import.meta.dirname, '../dist/public-entry.js');
            const args = ['--cwd', project.root, 'inspect', 'tables', matrix.tableId];
            const json = await execute(process.execPath, [binary, ...args, '--json']);
            expect(JSON.parse(json.stdout)).toMatchObject({
              table: {
                columns: expect.arrayContaining([
                  expect.objectContaining({ name: 'computed', formula: 'present' }),
                ]),
                conversionWarnings: schema.conversionWarnings,
              },
            });
            const human = await execute(process.execPath, [binary, ...args]);
            expect(human.stdout).toContain('formula');
            expect(human.stdout).toContain('xlsx-merged-cells');
          }
        } finally {
          backend.close();
          await projected?.close();
        }
      },
    );
  },
);

it('marks formula columns beyond the existing 1000-expression retention cap, issue430', async () => {
  await withTempProject(
    { files: { 'lore.yaml': 'version: 1\nname: formula-cap\nsources: [.]\n' } },
    async (project) => {
      let rows = row(1, [
        inlineString('A1', 'early'),
        inlineString('B1', 'late'),
        inlineString('C1', 'literal'),
      ]);
      for (let index = 2; index <= 1001; index++) {
        rows += row(index, [
          formula(`A${index}`, '1+1', 2),
          number(`B${index}`, index),
          number(`C${index}`, 7),
        ]);
      }
      rows += row(1002, [
        formula('A1002', '1+1', 2),
        formula('B1002', '3+4', 123),
        number('C1002', 7),
      ]);
      writeFileSync(
        project.path('formulas.xlsx'),
        await makeXlsx({ sheets: [{ name: 'Formulas', rows }] }),
      );
      const built = await runBuild({
        config: loadConfig({ cwd: project.root }),
        progress: new ProgressBus(),
      });
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      try {
        const runtime = createRuntime(backend);
        const table = (await runtime.listTables()).tables[0];
        if (table === undefined) throw new Error('Expected the actual formula-cap table.');
        const schema = await runtime.describeTable(table.tableId, { buildId: built.buildId });
        expect(schema.rowCount).toBe(1001);
        expect(schema.columns).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'early', formula: 'present' }),
            expect.objectContaining({ name: 'late', formula: 'present' }),
            expect.objectContaining({ name: 'literal', formula: 'absent' }),
          ]),
        );
      } finally {
        backend.close();
      }
    },
  );
});
