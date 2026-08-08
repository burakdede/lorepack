import { hashBytes, SCHEMA_VERSION, type Capability } from '@lorepack/core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCloudflareDeploymentTarget,
  createCloudflareWorkerFromBindings,
  type D1CatalogDatabaseLike,
  type D1DatabaseLike,
  type D1QueryDatabaseLike,
  type ProjectionMigrationDatabaseLike,
  type ProjectionMigrationStatementLike,
  type R2BucketLike,
} from '../src/index.js';

const PROJECT = 'contracted';
const ACTIVE_BUILD = `lore_${'a'.repeat(64)}` as const;
const CANDIDATE_BUILD = `lore_${'b'.repeat(64)}` as const;
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

class SqliteStatement implements ProjectionMigrationStatementLike, ReturnType<D1DatabaseLike['prepare']> {
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

class SqliteBindingsDatabase
  implements ProjectionMigrationDatabaseLike, D1CatalogDatabaseLike, D1QueryDatabaseLike, D1DatabaseLike
{
  readonly raw: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.raw = db;
  }

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this.raw, query);
  }
}

const directories: string[] = [];
const databases: DatabaseSync[] = [];

function trackDirectory(path: string): string {
  directories.push(path);
  return path;
}

function trackDatabase(db: DatabaseSync): DatabaseSync {
  databases.push(db);
  return db;
}

function createProjectFixture(): {
  readonly projectRoot: string;
  readonly projection: SqliteBindingsDatabase;
  readonly bucket: FakeR2Bucket;
} {
  const projectRoot = trackDirectory(mkdtempSync(join(tmpdir(), 'lore-cloudflare-public-')));
  mkdirSync(join(projectRoot, '.lore', 'objects'), { recursive: true });
  const projection = new SqliteBindingsDatabase(trackDatabase(new DatabaseSync(':memory:')));
  return { projectRoot, projection, bucket: new FakeR2Bucket() };
}

function createBuild(
  projectRoot: string,
  buildId: string,
  text: string,
  queryWord: string,
): string {
  const buildDirectory = join(projectRoot, '.lore', 'builds', buildId);
  const objectsDirectory = join(projectRoot, '.lore', 'objects');
  mkdirSync(join(buildDirectory, 'reports'), { recursive: true });

  const body = new TextEncoder().encode(text);
  const hash = hashBytes(body);
  const objectPath = join(objectsDirectory, 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash.slice(4));
  mkdirSync(dirname(objectPath), { recursive: true });
  writeFileSync(objectPath, body);

  writeFileSync(
    join(buildDirectory, 'manifest.json'),
    `${JSON.stringify(
      {
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
        capabilities: ['lexical-search', 'structured-context'],
        counts: { artifacts: 1, nodes: 1, chunks: 1, tables: 0, tableRows: 0 },
        warnings: [],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(buildDirectory, 'reports', 'warnings.json'), '[]\n');

  const db = new DatabaseSync(join(buildDirectory, 'context.sqlite'), {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  db.exec(`CREATE TABLE artifacts (
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
  db.exec(`CREATE TABLE supersessions (
    artifact_id TEXT NOT NULL,
    superseded_id TEXT NOT NULL,
    PRIMARY KEY (artifact_id, superseded_id)
  ) STRICT`);
  db.exec(`CREATE TABLE nodes (
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
  db.exec(`CREATE TABLE chunks (
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
  db.exec(`CREATE TABLE tables (
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
  db.exec(`CREATE TABLE table_columns (
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

  const artifactId = `${PROJECT}:guides/${queryWord}.md`;
  db.prepare(
    `INSERT INTO artifacts
      (id, source_id, relative_path, display_path, media_type, byte_size, content_hash,
       parser_id, parser_version, title, status, authority, object_hash, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    artifactId,
    `guides/${queryWord}.md`,
    `guides/${queryWord}.md`,
    `guides/${queryWord}.md`,
    'text/markdown',
    body.byteLength,
    'e'.repeat(64),
    'markdown',
    '1.0.0',
    queryWord,
    'active',
    50,
    hash,
    '{}',
  );
  db.prepare(
    `INSERT INTO nodes
      (id, artifact_id, parent_id, kind, ordinal, title, text, heading_path, line_start, line_end, metadata, revision_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${artifactId}@n0`,
    artifactId,
    null,
    'paragraph',
    0,
    null,
    text,
    `["${queryWord}"]`,
    1,
    1,
    '{}',
    '1'.repeat(64),
  );
  db.prepare(
    `INSERT INTO chunks
      (id, artifact_id, node_ids, heading_path, text, estimated_tokens, relative_path, line_start, line_end, page, revision_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${artifactId}@0`,
    artifactId,
    `["${artifactId}@n0"]`,
    `["${queryWord}"]`,
    text,
    12,
    `guides/${queryWord}.md`,
    1,
    1,
    null,
    '2'.repeat(64),
  );
  db.close();

  return buildDirectory;
}

afterEach(() => {
  while (databases.length > 0) {
    try {
      databases.pop()?.close();
    } catch {}
  }
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

describe('Cloudflare public candidate visibility, issue 89', () => {
  it('keeps a projected candidate invisible until activation and confirms activation through /v1/build', async () => {
    const fixture = createProjectFixture();
    const activeDirectory = createBuild(
      fixture.projectRoot,
      ACTIVE_BUILD,
      'activeword only appears in the active build',
      'activeword',
    );
    const candidateDirectory = createBuild(
      fixture.projectRoot,
      CANDIDATE_BUILD,
      'candidateword only appears in the candidate build',
      'candidateword',
    );

    const activeTarget = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
    });
    const activePlan = await activeTarget.plan({
      projectName: PROJECT,
      buildId: ACTIVE_BUILD,
      buildDirectory: activeDirectory,
      buildCapabilities: ['lexical-search', 'structured-context'] as Capability[],
    });
    const activeReceipt = await activeTarget.apply(activePlan);
    await activeTarget.activate(activeReceipt);

    const candidateTarget = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
      publicBuildId: async () => {
        const response = await worker.fetch(new Request('https://worker.example/v1/build'));
        const payload = (await response.json()) as { buildId: string };
        return payload.buildId as typeof CANDIDATE_BUILD;
      },
    });
    const candidatePlan = await candidateTarget.plan({
      projectName: PROJECT,
      buildId: CANDIDATE_BUILD,
      buildDirectory: candidateDirectory,
      buildCapabilities: ['lexical-search', 'structured-context'] as Capability[],
    });
    const candidateReceipt = await candidateTarget.apply(candidatePlan);

    const worker = createCloudflareWorkerFromBindings({
      CATALOG_DB: fixture.projection,
      OBJECTS: fixture.bucket,
      PROJECT_ID: PROJECT,
    });

    const beforeBuild = await worker.fetch(new Request('https://worker.example/v1/build'));
    expect((await beforeBuild.json()) as { buildId: string }).toMatchObject({ buildId: ACTIVE_BUILD });

    const beforeSearch = await worker.fetch(
      new Request('https://worker.example/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'candidateword',
          limit: 10,
          includeArchived: false,
          debug: false,
        }),
      }),
    );
    expect(((await beforeSearch.json()) as { hits: unknown[] }).hits).toHaveLength(0);

    const activation = await candidateTarget.activate(candidateReceipt);
    expect(activation.confirmedBuildId).toBe(CANDIDATE_BUILD);

    const afterBuild = await worker.fetch(new Request('https://worker.example/v1/build'));
    expect((await afterBuild.json()) as { buildId: string }).toMatchObject({
      buildId: CANDIDATE_BUILD,
    });

    const afterSearch = await worker.fetch(
      new Request('https://worker.example/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'candidateword',
          limit: 10,
          includeArchived: false,
          debug: false,
        }),
      }),
    );
    expect(((await afterSearch.json()) as { hits: unknown[] }).hits).toHaveLength(1);

    await worker.close();
  });
});
