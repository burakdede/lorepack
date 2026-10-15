import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempProject } from '../../test-support/src/temp-project.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const WORKER = join(ROOT, 'scripts/bench-rag-baseline-worker.mjs');
const FIXTURE_KEY = 'local-benchmark-fixture-key';
const WORKLOAD = JSON.parse(readFileSync(join(ROOT, 'benchmarks/corpus/queries.json'), 'utf8')) as {
  qualityQueries: { kind: string }[];
};
const HOSTED_REQUESTS =
  20 + WORKLOAD.qualityQueries.filter((query) => query.kind === 'context').length;

async function observeWorker(
  root: string,
  settings: Record<string, string>,
  mode = 'hosted',
  missingChunks = false,
) {
  const source = join(root, 'context.sqlite');
  const input = new DatabaseSync(source);
  try {
    input.exec(
      missingChunks
        ? 'CREATE TABLE unrelated (id TEXT)'
        : `CREATE TABLE chunks (
            id TEXT, relative_path TEXT, heading_path TEXT, text TEXT,
            line_start INTEGER, line_end INTEGER, page INTEGER
          )`,
    );
  } finally {
    input.close();
  }
  const temporary = join(root, 'worker-temp');
  mkdirSync(temporary);
  const witness = join(root, 'connections.json');
  const preload = join(root, 'observe-sqlite.mjs');
  writeFileSync(
    preload,
    `import sqlite from 'node:sqlite';
import {writeFileSync} from 'node:fs';
const opened=new Set();
for(const name of ['prepare','exec']) {
  const original=sqlite.DatabaseSync.prototype[name];
  sqlite.DatabaseSync.prototype[name]=function(...args){opened.add(this);return Reflect.apply(original,this,args);};
}
process.on('exit',()=>writeFileSync(${JSON.stringify(witness)},JSON.stringify([...opened].map(database=>({isOpen:database.isOpen})))));
`,
  );
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('RAG_BENCH_')) delete env[name];
  Object.assign(env, { TMPDIR: temporary, TMP: temporary, TEMP: temporary }, settings);
  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(preload).href, WORKER, source, JSON.stringify({ mode })],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 },
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
  const [code, signal] = await once(child, 'close');
  const connections = JSON.parse(readFileSync(witness, 'utf8')) as {
    isOpen: boolean;
  }[];
  expect(connections.length, stderr).toBeGreaterThan(0);
  expect(signal).toBeNull();
  expect(connections.filter((connection) => connection.isOpen)).toEqual([]);
  expect(readdirSync(temporary)).toEqual([]);
  return { code, stdout, stderr, connections };
}

describe('benchmark SQLite cleanup', () => {
  it.each(['RAG_BENCH_ENDPOINT', 'RAG_BENCH_API_KEY', 'RAG_BENCH_MODEL'])(
    'closes actual readers before reporting missing %s',
    async (missing) => {
      await withTempProject({}, async (project) => {
        const settings: Record<string, string> = {
          RAG_BENCH_ENDPOINT: 'http://127.0.0.1:1/unused',
          RAG_BENCH_API_KEY: FIXTURE_KEY,
          RAG_BENCH_MODEL: 'fixture-model',
        };
        delete settings[missing];
        const result = await observeWorker(project.path(''), settings);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(`${missing} is required for hosted mode.`);
        expect(result.stderr).not.toContain(FIXTURE_KEY);
      });
    },
    30_000,
  );

  it('closes a real source reader when its SQLite query fails', async () => {
    await withTempProject({}, async (project) => {
      const result = await observeWorker(project.path(''), {}, 'offline', true);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('no such table: chunks');
    });
  }, 30_000);

  it('closes all connections after the original offline workload succeeds', async () => {
    await withTempProject({}, async (project) => {
      const result = await observeWorker(project.path(''), {}, 'offline');
      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.protocol).toEqual({ name: 'lorepack-benchmark', version: 1 });
      expect(report.configuration.mode).toBe('offline');
      expect(report.samples.repetitions).toBe(20);
      expect(report.measurements.phases).toContainEqual(
        expect.objectContaining({ name: 'warm-query', samples: 30 }),
      );
    });
  }, 30_000);

  it.each(['success', 'http-error', 'transport-error'] as const)(
    'closes actual hosted readers after %s',
    async (outcome) => {
      let requests = 0;
      const server = createServer((request, response) => {
        requests++;
        if (outcome === 'transport-error') {
          request.socket.destroy();
          return;
        }
        request.resume();
        response.writeHead(outcome === 'http-error' ? 503 : 200, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify(
            outcome === 'http-error'
              ? { error: FIXTURE_KEY }
              : {
                  choices: [{ message: { content: 'A fixture answer.' } }],
                  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
                },
          ),
        );
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Missing fixture port.');
      try {
        await withTempProject({}, async (project) => {
          const result = await observeWorker(project.path(''), {
            RAG_BENCH_ENDPOINT: `http://127.0.0.1:${address.port}/responses`,
            RAG_BENCH_API_KEY: FIXTURE_KEY,
            RAG_BENCH_MODEL: 'fixture-model',
          });
          expect(result.stderr).not.toContain(FIXTURE_KEY);
          expect(requests).toBe(outcome === 'success' ? HOSTED_REQUESTS : 1);
          if (outcome === 'success') {
            expect(result.code, result.stderr).toBe(0);
            expect(JSON.parse(result.stdout).configuration.mode).toBe('hosted');
          } else {
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain(
              outcome === 'http-error'
                ? 'Hosted RAG request returned 503.'
                : 'Hosted RAG request failed:',
            );
          }
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
      }
    },
    30_000,
  );
});
