#!/usr/bin/env node
/**
 * Probe the current Cloudflare D1 projection write concurrency.
 *
 * This is a Phase 6 evidence artifact, not a release gate. It answers one narrow question:
 * how many D1 write statements are in flight at once while the current projection path runs?
 *
 * The current implementation is intentionally serial because Cloudflare D1 is single-threaded.
 * This probe records that choice on a real run, with machine metadata, so the repository has
 * evidence rather than only an implementation that happens to be serial today.
 *
 *   pnpm bench:cloudflare-projection
 *   node scripts/bench-cloudflare-projection.mjs --out benchmarks/cloudflare/local.json
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashBytes, SCHEMA_VERSION } from '../packages/core/dist/index.js';
import { createCloudflareDeploymentTarget } from '../packages/deploy-cloudflare/dist/index.js';

const PROJECT = 'bench';
const BUILD = `lore_${'a'.repeat(64)}`;
const ENDPOINT = 'https://example.workers.dev/mcp';
const WRITE_DELAY_MS = 2;
const TABLE_ROWS = 40;

class FakeR2Bucket {
  #objects = new Map();

  async put(key, value) {
    this.#objects.set(key, new Uint8Array(value));
  }

  async get(key) {
    const value = this.#objects.get(key);
    if (value === undefined) return null;
    return {
      arrayBuffer: async () =>
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    };
  }

  async head(key) {
    return this.#objects.has(key) ? {} : null;
  }
}

class TrackingStatement {
  #db;
  #query;
  #bindings = [];
  #tracking;

  constructor(db, query, tracking) {
    this.#db = db;
    this.#query = query;
    this.#tracking = tracking;
  }

  bind(...values) {
    this.#bindings = values;
    return this;
  }

  async run() {
    const statement = this.#db.prepare(this.#query);
    const trimmed = this.#query.trim().toLowerCase();
    const readOnly = trimmed.startsWith('select') || trimmed.startsWith('pragma');
    if (readOnly) {
      return { results: statement.all(...this.#bindings) };
    }

    this.#tracking.writeStatements += 1;
    this.#tracking.inflightWrites += 1;
    this.#tracking.maxInflightWrites = Math.max(
      this.#tracking.maxInflightWrites,
      this.#tracking.inflightWrites,
    );
    try {
      await sleep(WRITE_DELAY_MS);
      statement.run(...this.#bindings);
      return {};
    } finally {
      this.#tracking.inflightWrites -= 1;
    }
  }
}

class TrackingProjectionDatabase {
  raw;
  tracking;

  constructor(db) {
    this.raw = db;
    this.tracking = { inflightWrites: 0, maxInflightWrites: 0, writeStatements: 0 };
  }

  prepare(query) {
    return new TrackingStatement(this.raw, query, this.tracking);
  }
}

function makeBuildFixture(root) {
  const loreDirectory = join(root, '.lore');
  const buildDirectory = join(loreDirectory, 'builds', BUILD);
  const objectsDirectory = join(loreDirectory, 'objects');
  mkdirSync(join(buildDirectory, 'reports'), { recursive: true });
  mkdirSync(objectsDirectory, { recursive: true });

  writeFileSync(
    join(buildDirectory, 'manifest.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        buildId: BUILD,
        projectName: PROJECT,
        compilerVersion: '0.1.0',
        schemaVersion: SCHEMA_VERSION,
        configurationHash: 'c'.repeat(64),
        sourceFingerprint: 'd'.repeat(64),
        canonicalRoots: {
          artifacts: '1'.repeat(64),
          nodes: '2'.repeat(64),
          chunks: '3'.repeat(64),
          tables: '4'.repeat(64),
          objects: '5'.repeat(64),
        },
        capabilities: ['lexical-search', 'structured-context', 'table-query'],
        counts: { artifacts: 2, nodes: 2, chunks: 1, tables: 1, tableRows: TABLE_ROWS },
        warnings: [],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(buildDirectory, 'reports', 'warnings.json'), '[]\n');

  const bodyA = new TextEncoder().encode('rollback body');
  const bodyB = new TextEncoder().encode('pricing body');
  for (const [hash, body] of [
    [hashBytes(bodyA), bodyA],
    [hashBytes(bodyB), bodyB],
  ]) {
    const path = join(
      objectsDirectory,
      'sha256',
      hash.slice(0, 2),
      hash.slice(2, 4),
      hash.slice(4),
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }

  const buildDb = new DatabaseSync(join(buildDirectory, 'context.sqlite'), {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  buildDb.exec(`CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    display_path TEXT NOT NULL,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    parser_id TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL,
    authority INTEGER NOT NULL,
    object_hash TEXT NOT NULL,
    metadata TEXT NOT NULL
  ) STRICT`);
  buildDb.exec(`CREATE TABLE supersessions (
    artifact_id TEXT NOT NULL,
    superseded_id TEXT NOT NULL,
    PRIMARY KEY (artifact_id, superseded_id)
  ) STRICT`);
  buildDb.exec(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    parent_id TEXT,
    kind TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    title TEXT,
    text TEXT,
    heading_path TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER,
    metadata TEXT NOT NULL,
    revision_hash TEXT NOT NULL
  ) STRICT`);
  buildDb.exec(`CREATE TABLE chunks (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    node_ids TEXT NOT NULL,
    heading_path TEXT NOT NULL,
    text TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER,
    page INTEGER,
    revision_hash TEXT NOT NULL
  ) STRICT`);
  buildDb.exec(`CREATE TABLE tables (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sheet TEXT,
    sql_name TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER,
    cell_range TEXT,
    metadata TEXT NOT NULL
  ) STRICT`);
  buildDb.exec(`CREATE TABLE table_columns (
    table_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    sql_name TEXT NOT NULL,
    type TEXT NOT NULL,
    nullable INTEGER NOT NULL,
    null_count INTEGER NOT NULL,
    distinct_estimate INTEGER NOT NULL,
    distinct_is_exact INTEGER NOT NULL,
    min_value TEXT,
    max_value TEXT,
    PRIMARY KEY (table_id, ordinal)
  ) STRICT`);
  buildDb.exec(`CREATE TABLE t_products (
    c_0_sku TEXT,
    c_1_price REAL,
    c_2_available INTEGER
  ) STRICT`);

  buildDb
    .prepare(
      `INSERT INTO artifacts
        (id, source_id, relative_path, display_path, media_type, byte_size, content_hash,
         parser_id, parser_version, title, status, authority, object_hash, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'bench:guides/rollback.md',
      'guides/rollback.md',
      'guides/rollback.md',
      'guides/rollback.md',
      'text/markdown',
      96,
      'e'.repeat(64),
      'markdown',
      '1.0.0',
      'Rollback',
      'active',
      50,
      hashBytes(bodyA),
      '{}',
    );
  buildDb
    .prepare(
      `INSERT INTO artifacts
        (id, source_id, relative_path, display_path, media_type, byte_size, content_hash,
         parser_id, parser_version, title, status, authority, object_hash, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'bench:pricing.xlsx',
      'pricing.xlsx',
      'pricing.xlsx',
      'pricing.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      128,
      'f'.repeat(64),
      'xlsx',
      '1.0.0',
      'Pricing',
      'active',
      50,
      hashBytes(bodyB),
      '{}',
    );
  buildDb
    .prepare(
      `INSERT INTO nodes
        (id, artifact_id, parent_id, kind, ordinal, title, text, heading_path, line_start, line_end, metadata, revision_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'n0',
      'bench:guides/rollback.md',
      null,
      'paragraph',
      0,
      null,
      'To roll back a release, activate the previous build.',
      '["Rollback"]',
      3,
      3,
      '{}',
      '1'.repeat(64),
    );
  buildDb
    .prepare(
      `INSERT INTO nodes
        (id, artifact_id, parent_id, kind, ordinal, title, text, heading_path, line_start, line_end, metadata, revision_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'n1',
      'bench:guides/rollback.md',
      null,
      'paragraph',
      1,
      null,
      'Tell the team what changed after the rollback.',
      '["Rollback"]',
      5,
      5,
      '{}',
      '2'.repeat(64),
    );
  buildDb
    .prepare(
      `INSERT INTO chunks
        (id, artifact_id, node_ids, heading_path, text, estimated_tokens, relative_path, line_start, line_end, page, revision_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'bench:guides/rollback.md@0',
      'bench:guides/rollback.md',
      '["n0","n1"]',
      '["Rollback"]',
      'To roll back a release, activate the previous build. Tell the team what changed after the rollback.',
      24,
      'guides/rollback.md',
      3,
      5,
      null,
      '3'.repeat(64),
    );
  buildDb
    .prepare(
      `INSERT INTO tables
        (id, artifact_id, name, sheet, sql_name, row_count, relative_path, line_start, line_end, cell_range, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'bench:pricing.xlsx#Products',
      'bench:pricing.xlsx',
      'Products',
      'Products',
      't_products',
      TABLE_ROWS,
      'pricing.xlsx',
      null,
      null,
      'A1:C41',
      '{}',
    );
  for (const [ordinal, name, sqlName, type, min, max] of [
    [0, 'SKU', 'c_0_sku', 'text', 'A-1', `A-${TABLE_ROWS}`],
    [1, 'Price', 'c_1_price', 'real', '1.5', String(TABLE_ROWS * 1.5)],
    [2, 'Available', 'c_2_available', 'boolean', 'false', 'true'],
  ]) {
    buildDb
      .prepare(
        `INSERT INTO table_columns
          (table_id, ordinal, name, sql_name, type, nullable, null_count, distinct_estimate, distinct_is_exact, min_value, max_value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'bench:pricing.xlsx#Products',
        ordinal,
        name,
        sqlName,
        type,
        0,
        0,
        TABLE_ROWS,
        1,
        min,
        max,
      );
  }
  for (let index = 0; index < TABLE_ROWS; index += 1) {
    buildDb
      .prepare('INSERT INTO t_products (c_0_sku, c_1_price, c_2_available) VALUES (?, ?, ?)')
      .run(`A-${index + 1}`, Number((index + 1) * 1.5), index % 2 === 0 ? 1 : 0);
  }
  buildDb.close();

  return buildDirectory;
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return Math.round((sorted[position] ?? 0) * 100) / 100;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const root = mkdtempSync(join(tmpdir(), 'lorepack-cloudflare-probe-'));
try {
  const buildDirectory = makeBuildFixture(root);
  const projection = new TrackingProjectionDatabase(new DatabaseSync(':memory:'));
  const target = createCloudflareDeploymentTarget({
    projectId: PROJECT,
    endpoint: ENDPOINT,
    catalogDb: projection,
    objects: new FakeR2Bucket(),
  });

  const plan = await target.plan({
    projectName: PROJECT,
    buildId: BUILD,
    buildDirectory,
    buildCapabilities: ['lexical-search', 'structured-context', 'table-query'],
  });

  const progressEvents = [];
  const started = performance.now();
  await target.apply(plan, undefined, (update) => {
    if (update.stage === 'projecting') progressEvents.push(update);
  });
  const elapsedMs = performance.now() - started;
  const projectionBatchTotals = progressEvents
    .filter((event) => event.unit === 'batches' && typeof event.total === 'number')
    .map((event) => event.total);

  const report = {
    provisional: true,
    reason:
      'Measured on the development machine. This probe records the current D1 projection write concurrency, not a release gate.',
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      node: process.versions.node,
    },
    corpus: {
      buildId: BUILD,
      artifacts: 2,
      nodes: 2,
      chunks: 1,
      tables: 1,
      tableRows: TABLE_ROWS,
    },
    measurements: {
      totalApplyMs: Math.round(elapsedMs * 100) / 100,
      writeDelayMs: WRITE_DELAY_MS,
      d1WriteStatements: projection.tracking.writeStatements,
      maxInflightWrites: projection.tracking.maxInflightWrites,
      projectionProgressEvents: progressEvents.length,
      projectionBatchP50: percentile(projectionBatchTotals, 0.5),
      projectionBatchP95: percentile(projectionBatchTotals, 0.95),
    },
    conclusion: {
      chosenConcurrency: 1,
      overlappingWritesObserved: projection.tracking.maxInflightWrites > 1,
    },
  };

  const outIndex = process.argv.indexOf('--out');
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outIndex !== -1 && process.argv[outIndex + 1] !== undefined) {
    const out = process.argv[outIndex + 1];
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, serialized, 'utf8');
    console.log(`Wrote ${out}`);
  }
  console.log(serialized);
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
