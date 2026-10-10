import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);

/**
 * A table query through the bundled binary, the file npm users run (#639).
 *
 * The query runs in a forked child process whose entry is resolved at runtime. esbuild inlines
 * `@lorepack/backend-local` into `public-entry.js`, so a path that works from the package's own
 * `dist/` can be missing from the bundle, and every other suite drives the unbundled modules.
 * Only a real query through the real bundle shows that the child arrived next to it.
 */
const BIN = join(import.meta.dirname, '..', 'dist', 'public-entry.js');
const REPOSITORY = resolve(import.meta.dirname, '..', '..', '..');
/** Clear of the dev suite's 4700 range, the security suite's 47610 and the 43110 default. */
const PORT = 47_639;
const TABLE = 'bundled:products.csv#table';

let project: string;
let server: ChildProcess;
let output = '';

async function query(sql: string): Promise<{ status: number; body: string }> {
  const response = await fetch(
    `http://127.0.0.1:${PORT}/v1/tables/${encodeURIComponent(TABLE)}/query`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    },
  );
  return { status: response.status, body: await response.text() };
}

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), 'lore-bundled-query-'));
  writeFileSync(join(project, 'lore.yaml'), 'version: 1\nname: bundled\nsources:\n  - .\n');
  writeFileSync(join(project, 'products.csv'), 'sku,price\nA-1,10\nB-2,25\n');
  await run(process.execPath, [BIN, 'build'], { cwd: project, timeout: 60_000 });

  server = spawn(process.execPath, [BIN, 'serve', '--port', String(PORT)], {
    cwd: project,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  server.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const deadline = Date.now() + 30_000;
  while (!output.includes('REST') && server.exitCode === null && Date.now() < deadline) {
    await new Promise((settle) => setTimeout(settle, 100));
  }
  expect(output, `lorepack serve never started:\n${output}`).toContain('REST');
});

afterAll(async () => {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((settle) => {
      const give = setTimeout(settle, 10_000);
      server.once('exit', () => {
        clearTimeout(give);
        settle(undefined);
      });
    });
  }
  try {
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A leaked temporary directory must never fail a run that passed its assertions.
  }
});

describe('a table query through the bundled binary (#639)', () => {
  it('answers SELECT 1, so the query child ships with the bundle', async () => {
    const answer = await query('SELECT 1 AS x');
    expect(answer.body).not.toContain('LORE_E_INTERNAL');
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ columns: ['x'], rows: [{ x: 1 }] });
  });

  it('reads the rows of the CSV, with their source location', async () => {
    const described = await fetch(
      `http://127.0.0.1:${PORT}/v1/tables/${encodeURIComponent(TABLE)}`,
    );
    const table = (await described.json()) as {
      sqlName: string;
      columns: { name: string; sqlName: string }[];
    };
    const column = (name: string): string =>
      table.columns.find((candidate) => candidate.name === name)?.sqlName ?? name;

    const answer = await query(
      `SELECT ${column('sku')} AS sku, ${column('price')} AS price FROM ${table.sqlName} ORDER BY sku`,
    );
    expect(answer.status, answer.body).toBe(200);
    const parsed = JSON.parse(answer.body) as {
      rows: { sku: string; price: number }[];
      locator: { relativePath: string };
    };
    expect(parsed.rows).toEqual([
      { sku: 'A-1', price: 10 },
      { sku: 'B-2', price: 25 },
    ]);
    expect(parsed.locator.relativePath).toBe('products.csv');
  });

  it('never puts an absolute path of this install in a response', async () => {
    for (const sql of ['SELECT 1 AS x', 'SELECT * FROM nowhere', 'SELECT']) {
      const answer = await query(sql);
      // JSON escapes a Windows separator, so the escaped spelling is checked as well.
      for (const path of [REPOSITORY, project]) {
        expect(answer.body).not.toContain(path);
        expect(answer.body).not.toContain(JSON.stringify(path).slice(1, -1));
      }
    }
  });
});
