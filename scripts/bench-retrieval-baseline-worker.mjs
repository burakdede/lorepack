#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const buildDatabasePath = process.argv[2];
if (buildDatabasePath === undefined) throw new Error('A Lorepack context.sqlite path is required.');

const WORKLOAD = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'benchmarks/corpus/queries.json'), 'utf8'),
);
const SAMPLES = 3;
const QUERY_ITERATIONS = 30;

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return Math.round((sorted[position] ?? 0) * 100) / 100;
}

function peakRssMiB() {
  const maxRssBytes = Math.max(
    process.memoryUsage().rss,
    (process.resourceUsage().maxRSS ?? 0) * 1024,
  );
  return Math.round((maxRssBytes / 1024 ** 2) * 100) / 100;
}

function readChunks() {
  const db = new DatabaseSync(buildDatabasePath, { readOnly: true });
  const rows = db
    .prepare(
      'SELECT id, relative_path AS path, heading_path AS heading, text AS body FROM chunks ORDER BY id',
    )
    .all();
  db.close();
  return rows;
}

function createIndex(rows, path) {
  const started = performance.now();
  const db = new DatabaseSync(path);
  db.exec('CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED, path, heading, body)');
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO chunks_fts (id, path, heading, body) VALUES (?, ?, ?, ?)');
  for (const row of rows) insert.run(row.id, row.path, row.heading, row.body);
  db.exec('COMMIT');
  db.exec('PRAGMA optimize');
  db.close();
  return performance.now() - started;
}

function query(db, text) {
  return db
    .prepare(
      'SELECT id, path, heading, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT 10',
    )
    .all(text);
}

const rows = readChunks();
const directory = mkdtempSync(join(tmpdir(), 'lorepack-baseline-worker-'));
const indexSamples = [];
let indexBytes = 0;
try {
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const path = join(directory, `baseline-${sample}.sqlite`);
    indexSamples.push(createIndex(rows, path));
    indexBytes = statSync(path).size;
    rmSync(path, { force: true });
  }

  const path = join(directory, 'baseline.sqlite');
  createIndex(rows, path);
  const coldStarted = performance.now();
  const coldDb = new DatabaseSync(path, { readOnly: true });
  const coldRows = query(coldDb, WORKLOAD.searchQueries[0]);
  coldDb.close();
  const coldSearchMs = Math.round((performance.now() - coldStarted) * 100) / 100;

  const db = new DatabaseSync(path, { readOnly: true });
  const warm = [];
  const topK = [];
  for (let index = 0; index < QUERY_ITERATIONS; index += 1) {
    const started = performance.now();
    const result = query(db, WORKLOAD.searchQueries[index % WORKLOAD.searchQueries.length]);
    warm.push(performance.now() - started);
    topK.push(result.length);
  }
  db.close();
  const peak = peakRssMiB();
  rmSync(path, { force: true });
  console.log(
    JSON.stringify({
      machine: {
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model ?? 'unknown',
        cores: cpus().length,
        memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
        node: process.versions.node,
        sqlite: process.versions.sqlite ?? 'node:sqlite bundled SQLite',
      },
      indexBytes,
      peakRssMiB: peak,
      indexMs: {
        p50: percentile(indexSamples, 0.5),
        p95: percentile(indexSamples, 0.95),
        samples: SAMPLES,
      },
      coldSearchMs,
      warmSearchMs: {
        p50: percentile(warm, 0.5),
        p95: percentile(warm, 0.95),
        p99: percentile(warm, 0.99),
        samples: QUERY_ITERATIONS,
      },
      contextBundleMs: null,
      contextUnsupportedReason:
        'Direct FTS5 returns ranked rows only. It does not implement bounded context assembly or omission accounting.',
      topK: { min: Math.min(...topK, coldRows.length), max: Math.max(...topK, coldRows.length) },
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
