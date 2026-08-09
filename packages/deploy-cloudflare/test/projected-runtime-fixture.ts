import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type BuildId,
  type BuildManifest,
  type BuildScope,
  hashBytes,
  SCHEMA_VERSION,
} from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import {
  createCloudflareDeploymentTarget,
  D1ActiveBuildProvider,
  type D1CatalogDatabaseLike,
  D1CatalogStore,
  type D1DatabaseLike,
  type D1QueryDatabaseLike,
  D1TableStore,
  type ProjectionMigrationDatabaseLike,
  type ProjectionMigrationStatementLike,
  type R2BucketLike,
  R2ObjectStore,
} from '../src/index.js';

export const PROJECT = 'contracted';
export const ACTIVE_BUILD = `lore_${'a'.repeat(64)}` as BuildId;
export const CANDIDATE_BUILD = `lore_${'b'.repeat(64)}` as BuildId;
export const MATCHING_QUERY = 'rollback';
export const ARTIFACT_ID = 'contracted:guides/rollback.md';
export const TABLE_ID = 'contracted:pricing.xlsx#Products';
const ENDPOINT = 'https://example.workers.dev/mcp';

class FakeR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(value));
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return {
      arrayBuffer: async () =>
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer,
    };
  }

  async head(key: string): Promise<Record<string, never> | null> {
    return this.objects.has(key) ? {} : null;
  }
}

class SqliteStatement
  implements ProjectionMigrationStatementLike, ReturnType<D1DatabaseLike['prepare']>
{
  readonly #db: DatabaseSync;
  readonly #query: string;
  #bindings: readonly unknown[] = [];

  constructor(db: DatabaseSync, query: string) {
    this.#db = db;
    this.#query = query;
  }

  bind(...values: unknown[]): SqliteStatement {
    this.#bindings = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const statement = this.#db.prepare(this.#query);
    return (statement.get(...this.#bindings) as T | undefined) ?? null;
  }

  async run<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }> {
    const statement = this.#db.prepare(this.#query);
    const trimmed = this.#query.trim().toLowerCase();
    if (trimmed.startsWith('select') || trimmed.startsWith('pragma')) {
      return { results: statement.all(...this.#bindings) as readonly T[] };
    }
    statement.run(...this.#bindings);
    return {};
  }
}

class SqliteProjectionDatabase
  implements
    ProjectionMigrationDatabaseLike,
    D1CatalogDatabaseLike,
    D1QueryDatabaseLike,
    D1DatabaseLike
{
  readonly raw: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.raw = db;
  }

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this.raw, query);
  }
}

interface ProjectedFixtureState {
  readonly root: string;
  readonly target: ReturnType<typeof createCloudflareDeploymentTarget>;
  readonly candidateReceipt: {
    readonly buildId: string;
  };
  readonly close: () => Promise<void>;
}

let currentFixture: ProjectedFixtureState | null = null;

export async function createProjectedWorkerRuntimeFixture(): Promise<{
  readonly runtime: ReturnType<typeof createRuntime>;
  readonly knownArtifactId: string;
  readonly matchingQuery: string;
  readonly knownTableId: string;
  readonly close: () => Promise<void>;
}> {
  const root = mkdtempSync(join(tmpdir(), 'lore-cloudflare-contract-'));
  const projection = new SqliteProjectionDatabase(new DatabaseSync(':memory:'));
  const bucket = new FakeR2Bucket();

  try {
    const activeDirectory = createBuildDirectory(root, ACTIVE_BUILD, {
      text: 'To roll back a release, activate the previous build.',
      tableRows: [
        ['A-1', '19.99', 'false'],
        ['A-2', '4.50', 'false'],
        ['A-3', '', 'true'],
      ],
    });
    const candidateDirectory = createBuildDirectory(root, CANDIDATE_BUILD, {
      text: 'To roll back a release, activate the previous build and tell the team what changed.',
      tableRows: [
        ['A-1', '21.99', 'false'],
        ['A-2', '4.50', 'false'],
        ['A-4', '', 'true'],
      ],
    });

    const target = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: projection,
      objects: bucket,
    });

    const activePlan = await target.plan({
      projectName: PROJECT,
      buildId: ACTIVE_BUILD,
      buildDirectory: activeDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'],
    });
    const activeReceipt = await target.apply(activePlan);
    await target.activate(activeReceipt);

    const candidatePlan = await target.plan({
      projectName: PROJECT,
      buildId: CANDIDATE_BUILD,
      buildDirectory: candidateDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'],
    });
    const candidateReceipt = await target.apply(candidatePlan);

    const provider = new D1ActiveBuildProvider(projection);
    const runtime = createRuntime({
      provider,
      open: async (handle): Promise<BuildScope> => ({
        buildId: handle.buildId,
        catalog: new D1CatalogStore({
          db: projection,
          namespace: { projectId: PROJECT, buildId: handle.buildId },
        }),
        tables: new D1TableStore(projection, { projectId: PROJECT, buildId: handle.buildId }),
        objects: new R2ObjectStore(PROJECT, bucket),
      }),
      freshness: async () => 'clean',
    });

    const close = async (): Promise<void> => {
      try {
        projection.raw.close();
      } catch {}
      rmSync(root, { recursive: true, force: true });
      if (currentFixture?.root === root) currentFixture = null;
    };

    currentFixture = { root, target, candidateReceipt, close };

    return {
      runtime,
      knownArtifactId: ARTIFACT_ID,
      matchingQuery: MATCHING_QUERY,
      knownTableId: TABLE_ID,
      close,
    };
  } catch (error) {
    try {
      projection.raw.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function activateProjectedWorkerRuntimeFixture(): Promise<string> {
  if (currentFixture === null)
    throw new Error('No projected Cloudflare runtime fixture is active.');
  await currentFixture.target.activate(currentFixture.candidateReceipt as never);
  return CANDIDATE_BUILD;
}

function createBuildDirectory(
  projectRoot: string,
  buildId: BuildId,
  input: {
    readonly text: string;
    readonly tableRows: readonly [string, string, string][];
  },
): string {
  const buildDirectory = join(projectRoot, '.lore', 'builds', buildId);
  const objectsDirectory = join(projectRoot, '.lore', 'objects');
  mkdirSync(join(buildDirectory, 'reports'), { recursive: true });
  mkdirSync(objectsDirectory, { recursive: true });

  const markdownBody = new TextEncoder().encode(`# Rollback\n\n## Procedure\n\n${input.text}\n`);
  const spreadsheetBody = new TextEncoder().encode('pricing workbook body');
  const markdownHash = writeObject(objectsDirectory, markdownBody);
  const spreadsheetHash = writeObject(objectsDirectory, spreadsheetBody);

  const manifest: BuildManifest = {
    formatVersion: 1,
    buildId,
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
    counts: { artifacts: 2, nodes: 1, chunks: 1, tables: 1, tableRows: input.tableRows.length },
    warnings: [],
  };

  writeFileSync(join(buildDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(buildDirectory, 'reports', 'warnings.json'), '[]\n');

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
  buildDb.exec(`CREATE TABLE products (
    sku TEXT NOT NULL,
    list_price REAL,
    discontinued INTEGER NOT NULL
  ) STRICT`);

  buildDb
    .prepare(
      `INSERT INTO artifacts
      (id, source_id, relative_path, display_path, media_type, byte_size, content_hash,
       parser_id, parser_version, title, status, authority, object_hash, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ARTIFACT_ID,
      'guides/rollback.md',
      'guides/rollback.md',
      'guides/rollback.md',
      'text/markdown',
      markdownBody.byteLength,
      'e'.repeat(64),
      'markdown',
      '1.0.0',
      'Rollback',
      'active',
      50,
      markdownHash,
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
      'contracted:pricing.xlsx',
      'pricing.xlsx',
      'pricing.xlsx',
      'pricing.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      spreadsheetBody.byteLength,
      'f'.repeat(64),
      'xlsx',
      '1.0.0',
      'Pricing',
      'active',
      50,
      spreadsheetHash,
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
      ARTIFACT_ID,
      null,
      'paragraph',
      0,
      null,
      input.text,
      '["Rollback","Procedure"]',
      3,
      3,
      '{}',
      '1'.repeat(64),
    );
  buildDb
    .prepare(
      `INSERT INTO chunks
      (id, artifact_id, node_ids, heading_path, text, estimated_tokens, relative_path, line_start, line_end, page, revision_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${ARTIFACT_ID}@0`,
      ARTIFACT_ID,
      '["n0"]',
      '["Rollback","Procedure"]',
      input.text,
      16,
      'guides/rollback.md',
      3,
      3,
      null,
      '2'.repeat(64),
    );
  buildDb
    .prepare(
      `INSERT INTO tables
      (id, artifact_id, name, sheet, sql_name, row_count, relative_path, line_start, line_end, cell_range, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      TABLE_ID,
      'contracted:pricing.xlsx',
      'Products',
      'Products',
      'products',
      input.tableRows.length,
      'pricing.xlsx',
      1,
      input.tableRows.length + 1,
      `A1:C${String(input.tableRows.length + 1)}`,
      '{}',
    );
  buildDb
    .prepare(
      `INSERT INTO table_columns
      (table_id, ordinal, name, sql_name, type, nullable, null_count, distinct_estimate, distinct_is_exact, min_value, max_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(TABLE_ID, 0, 'SKU', 'sku', 'text', 0, 0, input.tableRows.length, 1, 'A-1', 'A-9');
  buildDb
    .prepare(
      `INSERT INTO table_columns
      (table_id, ordinal, name, sql_name, type, nullable, null_count, distinct_estimate, distinct_is_exact, min_value, max_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      TABLE_ID,
      1,
      'List Price',
      'list_price',
      'real',
      1,
      1,
      input.tableRows.length,
      1,
      '4.5',
      '21.99',
    );
  buildDb
    .prepare(
      `INSERT INTO table_columns
      (table_id, ordinal, name, sql_name, type, nullable, null_count, distinct_estimate, distinct_is_exact, min_value, max_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(TABLE_ID, 2, 'Discontinued', 'discontinued', 'boolean', 0, 0, 2, 1, 'false', 'true');

  for (const [sku, listPrice, discontinued] of input.tableRows) {
    buildDb
      .prepare('INSERT INTO products (sku, list_price, discontinued) VALUES (?, ?, ?)')
      .run(sku, listPrice === '' ? null : Number(listPrice), discontinued === 'true' ? 1 : 0);
  }

  buildDb.close();
  return buildDirectory;
}

function writeObject(objectsDirectory: string, value: Uint8Array): string {
  const hash = hashBytes(value);
  const objectPath = join(
    objectsDirectory,
    'sha256',
    hash.slice(0, 2),
    hash.slice(2, 4),
    hash.slice(4),
  );
  mkdirSync(dirname(objectPath), { recursive: true });
  writeFileSync(objectPath, value);
  return hash;
}
