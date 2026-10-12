import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { LoreClient } from '../../sdk/src/index.js';
import { runBuild } from '../src/services/build.js';
import { startServing } from '../src/services/serving.js';

const TABLE = 'invoices:invoices.csv#table';

it.each(['runtime', 'http', 'mcp'] as const)(
  'identifies the captured query with honest table precision through %s, issue695',
  async (surface) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: invoices\nsources: [.]\n',
          'invoices.csv':
            'invoice_id,net_cents,currency,approved\n00017,120000,EUR,false\n00018,35000,USD,true\n',
        },
      },
      async (project) => {
        const config = loadConfig({ cwd: project.root });
        const built = await runBuild({ config, progress: new ProgressBus() });
        const backend = createLocalRuntimeBackend({ projectRoot: project.root });
        const runtime = createRuntime(backend);
        const server =
          surface === 'runtime'
            ? null
            : await startServing({
                config,
                host: '127.0.0.1',
                port: 47_695,
                warn: () => {},
              });
        try {
          const described = await runtime.describeTable(TABLE);
          const column = (name: string) => {
            const found = described.columns.find((candidate) => candidate.name === name);
            if (found === undefined) throw new Error(`Missing independently named column ${name}`);
            return found.sqlName;
          };
          const sql = `SELECT ${column('invoice_id')}, ${column('net_cents')}, ${column('currency')}, ${column('approved')} FROM ${described.sqlName} WHERE ${column('invoice_id')} = '00017' ORDER BY ${column('net_cents')} DESC`;
          const request = { tableId: TABLE, sql };
          let result: Record<string, unknown>;
          if (surface === 'runtime') {
            result = await runtime.queryTable(request);
          } else if (surface === 'http') {
            if (server === null) throw new Error('The HTTP server must exist.');
            result = { ...(await new LoreClient({ baseUrl: server.url }).queryTable(TABLE, sql)) };
          } else {
            if (server === null) throw new Error('The MCP server must exist.');
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
                params: { name: 'lore_query_table', arguments: request },
              }),
            });
            expect(response.status).toBe(200);
            const emitted = await response.text();
            const raw = response.headers.get('content-type')?.includes('text/event-stream')
              ? emitted
                  .split('\n')
                  .find((line) => line.startsWith('data: '))
                  ?.slice(6)
              : emitted;
            if (raw === undefined) throw new Error('MCP did not return a data event.');
            const message = JSON.parse(raw) as {
              result: { structuredContent: Record<string, unknown>; content: { text: string }[] };
            };
            result = message.result.structuredContent;
            expect(JSON.parse(message.result.content[0]?.text ?? '')).toEqual(result);
          }
          expect(result.rows).toEqual([
            { invoice_id: '00017', net_cents: 120000, currency: 'EUR', approved: false },
          ]);
          expect(result.buildId).toBe(built.buildId);
          expect.soft(result).toMatchObject({ tableId: TABLE, provenancePrecision: 'table' });
          expect.soft(result.queryId).toMatch(/^query_[a-f0-9]{64}$/);
          expect(result.locator).toEqual(described.locator);
          expect(result).not.toHaveProperty('rowLocators');
        } finally {
          await server?.close();
          backend.close();
        }
      },
    );
  },
);

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

it('replays captured queries across limits, observations and retained activation, issue695', async () => {
  const csv =
    'invoice_id,net_cents,currency,approved\n00017,120000,EUR,false\n00018,35000,USD,true\n';
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: invoices\nsources: [.]\n',
        'invoices.csv': csv,
        'copy.csv': csv,
      },
    },
    async (project) => {
      const config = loadConfig({ cwd: project.root });
      const a = await runBuild({ config, progress: new ProgressBus() });
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      try {
        const runtime = createRuntime(backend);
        const table = await runtime.describeTable(TABLE);
        const column = (name: string) => {
          const found = table.columns.find((candidate) => candidate.name === name);
          if (found === undefined) throw new Error(`Missing column ${name}`);
          return found.sqlName;
        };
        const sql = `SELECT ${column('invoice_id')}, ${column('net_cents')} FROM ${table.sqlName} ORDER BY ${column('net_cents')} DESC`;
        const request = { tableId: TABLE, sql };
        const first = await runtime.queryTable(request);
        expect(first.rows).toEqual([
          { invoice_id: '00017', net_cents: 120000 },
          { invoice_id: '00018', net_cents: 35000 },
        ]);
        expect(
          (await runtime.queryTable({ ...request, limit: 100, buildId: a.buildId })).queryId,
        ).toBe(first.queryId);
        expect(
          (await createRuntime({ ...backend, freshness: async () => 'dirty' }).queryTable(request))
            .queryId,
        ).toBe(first.queryId);
        const limited = await runtime.queryTable({ ...request, limit: 1 });
        expect(limited.rows).toEqual([{ invoice_id: '00017', net_cents: 120000 }]);
        expect(limited.truncated).toBe(true);
        expect(limited.queryId).not.toBe(first.queryId);
        expect((await runtime.queryTable({ ...request, sql: `${sql} ` })).queryId).not.toBe(
          first.queryId,
        );
        const aggregate = await runtime.queryTable({
          tableId: TABLE,
          sql: `SELECT SUM(${column('net_cents')}) AS total FROM ${table.sqlName}`,
        });
        expect(aggregate.rows).toEqual([{ total: 155000 }]);
        expect(aggregate.provenancePrecision).toBe('table');
        expect(aggregate.locator).toEqual(table.locator);
        expect(aggregate.queryId).not.toBe(first.queryId);
        expect(aggregate).not.toHaveProperty('rowLocators');
        const constant = await runtime.queryTable({ tableId: TABLE, sql: 'SELECT 1 AS x' });
        const other = await runtime.queryTable({
          tableId: 'invoices:copy.csv#table',
          sql: 'SELECT 1 AS x',
        });
        expect(other.rows).toEqual(constant.rows);
        expect(other.queryId).not.toBe(constant.queryId);
        writeFileSync(join(project.root, 'invoices.csv'), `${csv}00019,5000,GBP,true\n`);
        const b = await runBuild({ config, progress: new ProgressBus() });
        expect(b.buildId).not.toBe(a.buildId);
        const current = await runtime.queryTable(request);
        expect(current.rows).toHaveLength(3);
        expect(current.buildId).toBe(b.buildId);
        expect(current.queryId).not.toBe(first.queryId);
        const retained = await runtime.queryTable({ ...request, buildId: a.buildId });
        expect(retained.rows).toEqual(first.rows);
        expect(retained.queryId).toBe(first.queryId);
        expect(retained.buildId).toBe(a.buildId);
      } finally {
        backend.close();
      }
    },
  );
});
