import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { validateBenchmarkReport } from '../../../scripts/benchmark-report.mjs';
import { redactSecrets } from '../../../scripts/rag-benchmark-security.mjs';
import { withTempProject } from '../../test-support/src/index.ts';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('the offline RAG baseline worker', () => {
  it('reports offline retrieval and prompt estimates without inventing model results', async () => {
    await withTempProject({}, async (project) => {
      const database = project.path('context.sqlite');
      workerDatabase(database);
      const result = await invokeWorker(database, {}, 'offline', {
        commitSha: 'a'.repeat(40),
        corpus: {
          manifestPath: 'benchmarks/corpus/manifest.json',
          manifestSha256: 'b'.repeat(64),
          scale: 'small',
          profile: 'mixed',
          artifacts: 1,
          bytes: 1,
          chunks: 1,
          tables: 0,
        },
        workload: {
          path: 'benchmarks/corpus/queries.json',
          sha256: 'c'.repeat(64),
          queryCount: WORKLOAD.searchQueries.length,
          contextTaskCount: WORKLOAD.contextTasks.length,
          tableQueryCount: 1,
        },
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.signal).toBeNull();
      const report = JSON.parse(result.stdout);
      expect(validateBenchmarkReport(report)).toEqual([]);
      expect(report.configuration).toMatchObject({
        mode: 'offline',
        provider: 'none',
        model: 'none',
      });
      expect(report.quality.search.cases).toBe(
        WORKLOAD.qualityQueries.filter(({ kind }) => kind === 'search').length,
      );
      expect(report.quality.context.cases).toBe(CONTEXT_CASES.length);
      expect(report.tokenAccounting).toMatchObject({
        status: 'estimated',
        tokenizer: 'rag-estimator-v1',
        model: null,
        completionTokens: null,
      });
      expect(report.tokenAccounting.promptTokens).toBeGreaterThan(0);
      expect(report.tokenAccounting.totalTokens).toBe(report.tokenAccounting.promptTokens);
      expect(report.tokenAccounting.promptTokens).toBeGreaterThanOrEqual(
        report.tokenAccounting.retrievedContextTokens,
      );
      expect(report.costAccounting).toMatchObject({
        status: 'not-applicable',
        inputUsd: null,
        outputUsd: null,
        totalUsd: null,
      });
      expect(report.quality.answer).toMatchObject({
        status: 'not-measured',
        citationCoverage: { numerator: 0, denominator: 0 },
        taskSuccess: { numerator: 0, denominator: 0 },
      });
      expect(report.measurements.phases.map((phase: { name: string }) => phase.name)).not.toContain(
        'model-generation',
      );
    });
  });

  it('refuses a missing build path before reading any database', () => {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/bench-rag-baseline-worker.mjs')],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('A Lorepack context.sqlite path is required.');
  });

  it('refuses an unsupported mode before opening the build', () => {
    const result = spawnSync(
      process.execPath,
      [
        join(ROOT, 'scripts/bench-rag-baseline-worker.mjs'),
        'absent.sqlite',
        JSON.stringify({ mode: 'unsupported' }),
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unsupported RAG benchmark mode: unsupported');
    expect(result.stderr).not.toContain('unable to open database');
  });
});

describe('RAG benchmark secret handling', () => {
  it('redacts the API key and bearer values from errors', () => {
    const message = redactSecrets(
      'request Bearer secret-token failed: secret-token',
      'secret-token',
    );
    expect(message).not.toContain('secret-token');
    expect(message).toContain('[REDACTED]');
  });

  it('does not alter errors when no secret is configured', () => {
    expect(redactSecrets('provider failed', undefined)).toBe('provider failed');
  });
});

const WORKER = join(ROOT, 'scripts/bench-rag-baseline-worker.mjs');
const WORKLOAD = JSON.parse(readFileSync(join(ROOT, 'benchmarks/corpus/queries.json'), 'utf8')) as {
  searchQueries: string[];
  contextTasks: string[];
  qualityQueries: { kind: string; query: string; expected: { artifact: string }[] }[];
};
const CONTEXT_CASES = WORKLOAD.qualityQueries.filter((entry) => entry.kind === 'context');
const HOSTED_REQUESTS = 20 + CONTEXT_CASES.length;
const FIXTURE_KEY = 'local-fixture-key';

function workerDatabase(path: string, empty = false): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE chunks (
      id TEXT PRIMARY KEY, relative_path TEXT, heading_path TEXT, text TEXT,
      line_start INTEGER, line_end INTEGER, page INTEGER
    )`);
    if (!empty) {
      db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'fixture:0',
        'fixture.md',
        '[]',
        [
          ...WORKLOAD.searchQueries,
          ...WORKLOAD.contextTasks,
          ...WORKLOAD.qualityQueries.map((entry) => entry.query),
        ].join('\n'),
        1,
        20,
        null,
      );
    }
  } finally {
    db.close();
  }
}

function invokeWorker(
  path: string,
  overrides: Record<string, string>,
  mode = 'hosted',
  metadata: Record<string, unknown> = {},
) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('RAG_BENCH_')) delete env[name];
  Object.assign(env, overrides);
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [WORKER, path, JSON.stringify({ ...metadata, mode })], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

async function hostedFixture(
  responseBody: unknown,
  options: {
    status?: number;
    invalidJson?: boolean;
    disconnect?: boolean;
    env?: Record<string, string>;
  } = {},
) {
  const requests: { authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    if (options.disconnect) {
      request.socket.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
    });
    response.writeHead(options.status ?? 200, { 'content-type': 'application/json' });
    response.end(options.invalidJson ? '{invalid-json' : JSON.stringify(responseBody));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Expected a loopback fixture port.');
  try {
    return await withTempProject({}, async (project) => {
      const database = project.path('context.sqlite');
      workerDatabase(database);
      const result = await invokeWorker(database, {
        RAG_BENCH_ENDPOINT: `http://127.0.0.1:${address.port}/responses`,
        RAG_BENCH_API_KEY: FIXTURE_KEY,
        RAG_BENCH_MODEL: 'fixture-model',
        ...options.env,
      });
      return { result, requests };
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
}

describe('RAG worker against a loopback provider fixture', () => {
  it('accounts for complete usage without treating citation mentions as task success', async () => {
    const answer = CONTEXT_CASES.flatMap((entry) =>
      entry.expected.map((expected) => expected.artifact),
    ).join(' ');
    const { result, requests } = await hostedFixture(
      {
        choices: [{ message: { content: answer } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      },
      { env: { RAG_BENCH_INPUT_USD_PER_MILLION: '2', RAG_BENCH_OUTPUT_USD_PER_MILLION: '5' } },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(requests).toHaveLength(HOSTED_REQUESTS);
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer ${FIXTURE_KEY}`);
      expect(request.body).toMatchObject({
        model: 'fixture-model',
        temperature: 0,
        messages: [
          { role: 'system', content: expect.stringContaining('Cite each source') },
          { role: 'user', content: expect.stringContaining('[source: fixture.md]') },
        ],
      });
    }
    const report = JSON.parse(result.stdout);
    expect(report.samples.repetitions).toBe(20);
    expect(report.tokenAccounting).toMatchObject({
      status: 'estimated',
      tokenizer: 'provider-reported',
      model: 'fixture-model',
      promptTokens: HOSTED_REQUESTS * 100,
      completionTokens: HOSTED_REQUESTS * 10,
      totalTokens: HOSTED_REQUESTS * 110,
    });
    expect(report.costAccounting).toMatchObject({ status: 'estimated', currency: 'USD' });
    expect(report.costAccounting.inputUsd).toBeCloseTo((HOSTED_REQUESTS * 100 * 2) / 1_000_000);
    expect(report.costAccounting.outputUsd).toBeCloseTo((HOSTED_REQUESTS * 10 * 5) / 1_000_000);
    expect(report.costAccounting.totalUsd).toBeCloseTo((HOSTED_REQUESTS * 250) / 1_000_000);
    expect(report.quality.answer).toMatchObject({
      status: 'measured',
      citationCoverage: { numerator: CONTEXT_CASES.length, denominator: CONTEXT_CASES.length },
      taskSuccess: { numerator: 0, denominator: 0 },
    });
    expect(report.measurements.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'index-build', samples: 3 }),
        expect.objectContaining({ name: 'warm-query', samples: 30 }),
        expect.objectContaining({ name: 'context-assembly', samples: 20 }),
        expect.objectContaining({ name: 'model-generation', samples: HOSTED_REQUESTS }),
      ]),
    );
  }, 30_000);

  it.each([false, true])(
    'does not invent usage or answers from an incomplete provider response (invalid JSON=%s)',
    async (invalidJson) => {
      const { result, requests } = await hostedFixture({}, { invalidJson });
      expect(result.code, result.stderr).toBe(0);
      expect(requests).toHaveLength(HOSTED_REQUESTS);
      const report = JSON.parse(result.stdout);
      expect(report.tokenAccounting.promptTokens).toBeGreaterThan(0);
      expect(report.tokenAccounting.totalTokens).toBe(report.tokenAccounting.promptTokens);
      expect(report.tokenAccounting.completionTokens).toBe(0);
      expect(report.costAccounting).toMatchObject({ status: 'not-applicable', totalUsd: null });
      expect(report.quality.answer).toMatchObject({
        citationCoverage: { numerator: 0, denominator: CONTEXT_CASES.length },
        taskSuccess: { numerator: 0, denominator: 0 },
      });
    },
    30_000,
  );

  it('refuses an HTTP provider failure without emitting a successful report or credentials', async () => {
    const { result, requests } = await hostedFixture({ error: FIXTURE_KEY }, { status: 503 });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(requests).toHaveLength(1);
    expect(result.stderr).toContain('Hosted RAG request returned 503.');
    expect(result.stderr).not.toContain(FIXTURE_KEY);
  });

  it('reports transport failure without emitting a successful report or credentials', async () => {
    const { result } = await hostedFixture({}, { disconnect: true });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Hosted RAG request failed:');
    expect(result.stderr).not.toContain(FIXTURE_KEY);
  }, 30_000);

  it.each(['RAG_BENCH_ENDPOINT', 'RAG_BENCH_API_KEY', 'RAG_BENCH_MODEL'])(
    'requires %s before a hosted request',
    async (missing) => {
      await withTempProject({}, async (project) => {
        const database = project.path('context.sqlite');
        workerDatabase(database);
        const env: Record<string, string> = {
          RAG_BENCH_ENDPOINT: 'http://127.0.0.1:1/unused',
          RAG_BENCH_API_KEY: FIXTURE_KEY,
          RAG_BENCH_MODEL: 'fixture-model',
        };
        delete env[missing];
        const result = await invokeWorker(database, env);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(`${missing} is required for hosted mode.`);
      });
    },
    30_000,
  );

  it('reports empty retrieval honestly while running the original offline workload', async () => {
    await withTempProject({}, async (project) => {
      const database = project.path('context.sqlite');
      workerDatabase(database, true);
      const result = await invokeWorker(database, {}, 'offline');
      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.resources.topK).toEqual({ min: 0, max: 0 });
      expect(report.tokenAccounting.retrievedContextTokens).toBe(0);
      expect(report.quality.provenance).toEqual({ numerator: 0, denominator: 0 });
      expect(report.quality.context.expectedCitations).toBe(0);
      expect(report.quality.answer).toMatchObject({
        status: 'not-measured',
        citationCoverage: { numerator: 0, denominator: 0 },
      });
      expect(report.samples.repetitions).toBe(20);
    });
  });
});
