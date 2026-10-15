import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const INPUT = 'RAG_BENCH_INPUT_USD_PER_MILLION';
const OUTPUT = 'RAG_BENCH_OUTPUT_USD_PER_MILLION';
const server = createServer((request, response) => {
  request.resume();
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      usage:
        request.url === '/incomplete'
          ? {}
          : { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    }),
  );
});
let directory: string;
let endpoint: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'lorepack-rag-pricing-'));
  const db = new DatabaseSync(join(directory, 'context.sqlite'));
  try {
    db.exec(`CREATE TABLE chunks (
      id TEXT, relative_path TEXT, heading_path TEXT, text TEXT,
      line_start INTEGER, line_end INTEGER, page INTEGER
    )`);
  } finally {
    db.close();
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a loopback port.');
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  rmSync(directory, { recursive: true, force: true });
});

async function reportFor(rates: Record<string, string>, incompleteUsage = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('RAG_BENCH_')) delete env[key];
  Object.assign(env, {
    RAG_BENCH_ENDPOINT: `${endpoint}/${incompleteUsage ? 'incomplete' : 'complete'}`,
    RAG_BENCH_API_KEY: 'loopback-pricing-fixture',
    RAG_BENCH_MODEL: 'fixture-model',
    ...rates,
  });
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        [
          join(ROOT, 'scripts/bench-rag-baseline-worker.mjs'),
          join(directory, 'context.sqlite'),
          JSON.stringify({ mode: 'hosted' }),
        ],
        { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => resolveResult({ code, stdout, stderr }));
    },
  );
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const unavailableCost = {
  status: 'not-applicable',
  currency: null,
  pricingSource: null,
  inputUsd: null,
  outputUsd: null,
  totalUsd: null,
};

describe('hosted benchmark pricing requires known rates', () => {
  it.each([
    { name: 'both absent', rates: {} },
    { name: 'input absent', rates: { [OUTPUT]: '5' } },
    { name: 'output absent', rates: { [INPUT]: '2' } },
    ...[INPUT, OUTPUT].flatMap((key) =>
      ['', '  \t', 'not-a-price', 'Infinity', 'NaN', '-1'].map((value) => ({
        name: `${key}=${JSON.stringify(value)}`,
        rates: { [INPUT]: '2', [OUTPUT]: '5', [key]: value },
      })),
    ),
  ])(
    'keeps cost unavailable for $name',
    async ({ rates }) => {
      const report = await reportFor(rates);
      expect(report.costAccounting).toEqual(unavailableCost);
      expect(report.tokenAccounting.promptTokens).toBeGreaterThan(0);
      expect(report.tokenAccounting.completionTokens).toBeGreaterThan(0);
      expect(report.tokenAccounting.totalTokens).toBe(
        report.tokenAccounting.promptTokens + report.tokenAccounting.completionTokens,
      );
    },
    30_000,
  );

  it.each([
    { input: '0', output: '0' },
    { input: '0', output: '5' },
    { input: '2', output: '0' },
    { input: ' 2.5 ', output: '7.5' },
  ])(
    'estimates explicitly supplied rates $input/$output',
    async ({ input, output }) => {
      const report = await reportFor({ [INPUT]: input, [OUTPUT]: output });
      expect(report.costAccounting).toMatchObject({ status: 'estimated', currency: 'USD' });
      const inputUsd = (report.tokenAccounting.promptTokens * Number(input)) / 1_000_000;
      const outputUsd = (report.tokenAccounting.completionTokens * Number(output)) / 1_000_000;
      expect(report.costAccounting.inputUsd).toBeCloseTo(inputUsd, 12);
      expect(report.costAccounting.outputUsd).toBeCloseTo(outputUsd, 12);
      expect(report.costAccounting.totalUsd).toBeCloseTo(inputUsd + outputUsd, 12);
    },
    30_000,
  );

  it('keeps cost unavailable when usage is incomplete despite known rates', async () => {
    const report = await reportFor({ [INPUT]: '2', [OUTPUT]: '5' }, true);
    expect(report.costAccounting).toEqual(unavailableCost);
    expect(report.tokenAccounting.totalTokens).toBe(report.tokenAccounting.promptTokens);
  }, 30_000);
});
