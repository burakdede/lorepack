import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const BINARY = join(import.meta.dirname, '../dist/public-entry.js');
const TABLE = 'invoices:invoices.csv#table';

function ready(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => finish(new Error(`CLI serving did not start: ${output}`)),
      30_000,
    );
    const data = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = /REST\s+(http:\/\/127\.0\.0\.1:\d+)\/v1/.exec(output);
      if (match?.[1] !== undefined) finish(null, match[1]);
    };
    const exited = () => finish(new Error(`CLI serving exited before readiness: ${output}`));
    const failed = (cause: Error) => finish(cause);
    const finish = (cause: Error | null, url?: string) => {
      clearTimeout(timeout);
      child.stdout?.off('data', data);
      child.stderr?.off('data', data);
      child.off('exit', exited);
      child.off('error', failed);
      if (cause !== null) reject(cause);
      else if (url !== undefined) resolve(url);
    };
    child.stdout?.on('data', data);
    child.stderr?.on('data', data);
    child.once('exit', exited);
    child.once('error', failed);
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI serving did not stop within its cleanup deadline.'));
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

it('preserves SQL suggestions through the runtime and bundled CLI HTTP/MCP serving paths', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: invoices\nsources: [.]\n',
        'invoices.csv': 'invoice_id,amount\n0017,120\n',
      },
    },
    async (project) => {
      const built = await execute(
        process.execPath,
        [BINARY, '--cwd', project.root, '--json', 'build'],
        { timeout: 60_000 },
      );
      const { buildId } = JSON.parse(built.stdout) as { buildId: string };
      expect(buildId).toMatch(/^lore_[a-f0-9]{64}$/);
      const retained = new Map(
        ['context.sqlite', 'manifest.json', 'reports/build-id-inputs.json'].map((name) => {
          const path = project.path(`.lore/builds/${buildId}/${name}`);
          return [path, readFileSync(path)] as const;
        }),
      );
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      const runtime = createRuntime(backend);
      let child: ChildProcess | undefined;
      try {
        const table = await runtime.describeTable(TABLE);
        child = spawn(
          process.execPath,
          [BINARY, '--cwd', project.root, 'serve', '--build', buildId, '--port', '47739'],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        const url = await ready(child);
        const cases = [
          { sql: `SELXCT * FROM ${table.sqlName}`, remediation: 'Did you mean SELECT?' },
          { sql: `XELECT * FROM ${table.sqlName}`, remediation: 'Did you mean SELECT?' },
          { sql: 'WIXH x AS (SELECT 1) SELECT * FROM x', remediation: 'Did you mean WITH?' },
          { sql: 'VALUXS(1)', remediation: 'Did you mean VALUES?' },
          { sql: 'VALUESS(1)', remediation: 'Did you mean VALUES?' },
        ];
        for (const entry of cases) {
          const request = { tableId: TABLE, sql: entry.sql };
          await expect(runtime.queryTable(request)).rejects.toMatchObject({
            code: 'LORE_E_SQL_REJECTED',
            remediation: entry.remediation,
          });
          const http = await fetch(`${url}/v1/tables/${encodeURIComponent(TABLE)}/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql: entry.sql }),
          });
          expect(http.status).toBe(400);
          expect(await http.json()).toMatchObject({
            error: {
              code: 'LORE_E_SQL_REJECTED',
              remediation: entry.remediation,
            },
          });
          const mcp = await fetch(`${url}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'lore_query_table',
                arguments: request,
              },
            }),
          });
          expect(mcp.status).toBe(200);
          const emitted = await mcp.text();
          const text = mcp.headers.get('content-type')?.includes('text/event-stream')
            ? emitted
                .split('\n')
                .find((line) => line.startsWith('data: '))
                ?.slice(6)
            : emitted;
          if (text === undefined) throw new Error('MCP did not emit a data event.');
          const response = JSON.parse(text) as {
            result: { isError: boolean; content: { text: string }[] };
          };
          expect(response.result.isError).toBe(true);
          expect(response.result.content[0]?.text).toContain('LORE_E_SQL_REJECTED');
          expect(response.result.content[0]?.text).toContain(entry.remediation);
        }
        await expect(
          runtime.queryTable({ tableId: TABLE, sql: `SELECT * FROM ${table.sqlName}` }),
        ).resolves.toMatchObject({
          buildId,
          rows: [{ invoice_id: '0017', amount: 120 }],
        });
        await expect(
          runtime.queryTable({ tableId: TABLE, sql: `DELETE FROM ${table.sqlName}` }),
        ).rejects.toMatchObject({
          code: 'LORE_E_SQL_REJECTED',
          remediation: expect.stringMatching(/read-only/i),
        });
        for (const [path, bytes] of retained) expect(readFileSync(path)).toEqual(bytes);
      } finally {
        try {
          if (child !== undefined) await stop(child);
        } finally {
          backend.close();
        }
      }
    },
  );
});
