#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const buildDatabasePath = process.argv[2];
if (buildDatabasePath === undefined) throw new Error('A Lorepack context.sqlite path is required.');
const metadata = JSON.parse(process.argv[3] ?? '{}');

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
      `SELECT id, relative_path AS path, heading_path AS heading, text AS body,
              line_start AS lineStart, line_end AS lineEnd, page
         FROM chunks
        ORDER BY id`,
    )
    .all();
  db.close();
  return rows;
}

function createIndex(rows, path) {
  const started = performance.now();
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED, path, heading, body, lineStart UNINDEXED, lineEnd UNINDEXED, page UNINDEXED, cellRange UNINDEXED)',
  );
  db.exec('BEGIN');
  const insert = db.prepare(
    'INSERT INTO chunks_fts (id, path, heading, body, lineStart, lineEnd, page, cellRange) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(row.id, row.path, row.heading, row.body, row.lineStart, row.lineEnd, row.page, null);
  }
  db.exec('COMMIT');
  db.exec('PRAGMA optimize');
  db.close();
  return performance.now() - started;
}

function query(db, text) {
  return db
    .prepare(
      'SELECT id, path, heading, lineStart, lineEnd, page, cellRange, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT 10',
    )
    .all(text);
}

function expectedPath(artifact) {
  return `pack-000/000-${artifact.split('/').at(-1)}`;
}

function matchesLocation(actual, expected) {
  if (actual.path !== expectedPath(expected.artifact)) return false;
  for (const [actualKey, expectedKey] of [
    ['page', 'page'],
    ['lineStart', 'lineStart'],
    ['lineEnd', 'lineEnd'],
    ['cellRange', 'cellRange'],
  ]) {
    if (expected[expectedKey] !== undefined && actual[actualKey] !== expected[expectedKey])
      return false;
  }
  if (expected.headingPath !== undefined) {
    if (JSON.stringify(JSON.parse(actual.heading || '[]')) !== JSON.stringify(expected.headingPath))
      return false;
  }
  return true;
}

function quality(db) {
  const searches = WORKLOAD.qualityQueries.filter((entry) => entry.kind === 'search');
  const cases = searches.map((entry) => ({
    ...entry,
    hits: query(db, entry.query),
  }));
  const hitAt = (entry, limit) =>
    entry.expected.some((expected) =>
      entry.hits.slice(0, limit).some((hit) => matchesLocation(hit, expected)),
    );
  const expectedLocationHits = cases.filter((entry) => hitAt(entry, 5)).length;
  return {
    search: {
      cases: cases.length,
      hitAt1: cases.filter((entry) => hitAt(entry, 1)).length / cases.length,
      hitAt5: cases.filter((entry) => hitAt(entry, 5)).length / cases.length,
      expectedLocationCoverage: expectedLocationHits / cases.length,
    },
    provenance: {
      available: true,
      coverage: cases.length === 0 ? 0 : 1,
      note: 'The direct index stores the normalized chunk coordinates as unindexed columns.',
    },
    context: {
      status: 'not-measured',
      reason:
        'Direct FTS5 returns ranked rows and coordinates only. It does not assemble bounded context or omissions.',
    },
  };
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
  const qualityResult = (() => {
    const qualityDb = new DatabaseSync(path, { readOnly: true });
    const result = quality(qualityDb);
    qualityDb.close();
    return result;
  })();
  const peak = peakRssMiB();
  rmSync(path, { force: true });
  const commitSha =
    metadata.commitSha ?? '0000000000000000000000000000000000000000000000000000000000000000';
  const report = {
    protocol: { name: 'lorepack-benchmark', version: 1 },
    reportId: `sqlite-fts5-${metadata.scale ?? 'unknown'}-${metadata.profile ?? 'unknown'}-${commitSha.slice(0, 12)}`,
    generatedAt: new Date().toISOString(),
    commitSha,
    implementation: { name: 'sqlite-fts5-direct', version: process.versions.sqlite ?? 'bundled' },
    environment: {
      platform: process.platform,
      arch: process.arch,
      runner:
        process.env.GITHUB_ACTIONS === 'true'
          ? (process.env.RUNNER_NAME ?? 'github-actions')
          : 'local',
      node: process.versions.node,
      cpu: cpus()[0]?.model ?? 'unknown',
      storageClass: process.env.LORE_BENCH_STORAGE_CLASS ?? 'unknown',
      sqlite: process.versions.sqlite ?? 'node:sqlite bundled SQLite',
    },
    corpus: {
      manifestPath: 'benchmarks/corpus/manifest.json',
      manifestSha256: metadata.manifestSha256,
      scale: metadata.scale,
      profile: metadata.profile,
      artifacts: metadata.artifacts,
      bytes: metadata.bytes,
      chunks: rows.length,
      tables: metadata.tables,
    },
    workload: {
      path: 'benchmarks/corpus/queries.json',
      sha256: metadata.workloadSha256,
      queryCount: WORKLOAD.searchQueries.length,
      contextTaskCount: WORKLOAD.contextTasks.length,
      tableQueryCount: 1,
    },
    samples: { warmup: 1, repetitions: SAMPLES, timeoutMs: 30000 },
    tokenAccounting: {
      status: 'not-applicable',
      tokenizer: null,
      model: null,
      inputTokens: null,
      retrievedContextTokens: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    },
    measurements: {
      phases: [
        {
          name: 'index-build',
          p50Ms: percentile(indexSamples, 0.5),
          p95Ms: percentile(indexSamples, 0.95),
          samples: SAMPLES,
          errorCount: 0,
        },
        { name: 'cold-query', p50Ms: coldSearchMs, p95Ms: coldSearchMs, samples: 1, errorCount: 0 },
        {
          name: 'warm-query',
          p50Ms: percentile(warm, 0.5),
          p95Ms: percentile(warm, 0.95),
          samples: QUERY_ITERATIONS,
          errorCount: 0,
        },
      ],
    },
    quality: qualityResult,
    configuration: {
      tokenizer: 'unicode61',
      ranking: 'bm25(chunks_fts) ascending score',
      columns: ['path', 'heading', 'body'],
      normalization:
        'The exact normalized chunks emitted by Lorepack are indexed without translation.',
      sourceBoundary: 'After parsing, normalization and chunking; build lifecycle is excluded.',
    },
    claims: [
      {
        id: 'direct-fts5-latency',
        status: 'measured',
        statement: 'Direct SQLite FTS5 query latency is measured over the shared workload.',
        evidence: ['measurements.phases[name=warm-query]'],
      },
      {
        id: 'direct-fts5-context',
        status: 'not-measured',
        statement: 'Direct SQLite FTS5 does not implement bounded context assembly.',
        evidence: ['quality.context'],
      },
      {
        id: 'direct-fts5-semantic-quality',
        status: 'not-measured',
        statement: 'Semantic retrieval quality is not claimed by the direct lexical baseline.',
        evidence: [],
      },
    ],
  };
  console.log(
    JSON.stringify({
      ...report,
      resources: {
        indexBytes,
        peakRssMiB: peak,
        topK: { min: Math.min(...topK, coldRows.length), max: Math.max(...topK, coldRows.length) },
      },
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
