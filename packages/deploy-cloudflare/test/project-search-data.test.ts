import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BuildManifest } from '@lorepack/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type D1CatalogDatabaseLike, D1CatalogStore } from '../src/catalog.js';
import { projectBuildMetadata } from '../src/project-metadata.js';
import { projectSearchData } from '../src/project-search-data.js';
import {
  type ProjectionMigrationDatabaseLike,
  type ProjectionMigrationStatementLike,
  runProjectionMigrations,
} from '../src/projection-migrations.js';

const PROJECT = 'contracted';
const BUILD = `lore_${'a'.repeat(64)}`;

const MANIFEST: BuildManifest = {
  formatVersion: 1,
  buildId: BUILD,
  projectName: PROJECT,
  compilerVersion: '0.1.0',
  schemaVersion: 1,
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
  counts: { artifacts: 1, nodes: 2, chunks: 1, tables: 0, tableRows: 0 },
  warnings: [],
};

class SqliteStatement
  implements ProjectionMigrationStatementLike, ReturnType<D1CatalogDatabaseLike['prepare']>
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

class SqliteProjectionDatabase implements ProjectionMigrationDatabaseLike, D1CatalogDatabaseLike {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this.#db, query);
  }
}

const directories: string[] = [];
const databases: DatabaseSync[] = [];

function makeBuildDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'lore-build-'));
  directories.push(directory);
  mkdirSync(join(directory, 'reports'));
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  writeFileSync(join(directory, 'reports', 'warnings.json'), '[]\n');

  const db = new DatabaseSync(join(directory, 'context.sqlite'), {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  databases.push(db);
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

  db.prepare(
    `INSERT INTO artifacts
      (id, source_id, relative_path, display_path, media_type, byte_size, content_hash,
       parser_id, parser_version, title, status, authority, object_hash, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'contracted:guides/rollback.md',
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
    'f'.repeat(64),
    JSON.stringify({ headings: ['Rollback'] }),
  );
  db.prepare(
    `INSERT INTO nodes
      (id, artifact_id, parent_id, kind, ordinal, title, text, heading_path, line_start, line_end, metadata, revision_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'n0',
    'contracted:guides/rollback.md',
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
  db.prepare(
    `INSERT INTO nodes
      (id, artifact_id, parent_id, kind, ordinal, title, text, heading_path, line_start, line_end, metadata, revision_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'n1',
    'contracted:guides/rollback.md',
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
  db.prepare(
    `INSERT INTO chunks
      (id, artifact_id, node_ids, heading_path, text, estimated_tokens, relative_path, line_start, line_end, page, revision_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'contracted:guides/rollback.md@0',
    'contracted:guides/rollback.md',
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
  db.close();
  databases.pop();

  return directory;
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

describe('projectSearchData, issue 87', () => {
  it('projects nodes and chunks so the Worker search path reads real projected data', async () => {
    const buildDirectory = makeBuildDirectory();
    const projection = new DatabaseSync(':memory:');
    databases.push(projection);
    const db = new SqliteProjectionDatabase(projection);
    await runProjectionMigrations(db, () => '2026-08-08T12:00:00.000Z');
    await projectBuildMetadata({
      db,
      projectId: PROJECT,
      buildDirectory,
      projectedAt: '2026-08-08T12:15:00.000Z',
    });

    const result = await projectSearchData({
      db,
      projectId: PROJECT,
      buildId: BUILD,
      buildDirectory,
    });
    expect(result).toEqual({ projectedNodes: 2, projectedChunks: 1, projectedFtsRows: 1 });

    const store = new D1CatalogStore({ db, namespace: { projectId: PROJECT, buildId: BUILD } });
    expect(await store.countChunks()).toBe(1);
    expect(await store.nodes('contracted:guides/rollback.md')).toEqual([
      {
        nodeId: 'n0',
        artifactId: 'contracted:guides/rollback.md',
        kind: 'paragraph',
        ordinal: 0,
        title: null,
        text: 'To roll back a release, activate the previous build.',
        headingPath: ['Rollback'],
        lineStart: 3,
        lineEnd: 3,
      },
      {
        nodeId: 'n1',
        artifactId: 'contracted:guides/rollback.md',
        kind: 'paragraph',
        ordinal: 1,
        title: null,
        text: 'Tell the team what changed after the rollback.',
        headingPath: ['Rollback'],
        lineStart: 5,
        lineEnd: 5,
      },
    ]);
    expect(await store.search('rollback', { limit: 10, match: 'all' })).toEqual([
      {
        chunkId: 'contracted:guides/rollback.md@0',
        artifactId: 'contracted:guides/rollback.md',
        relativePath: 'guides/rollback.md',
        displayPath: 'guides/rollback.md',
        headingPath: ['Rollback'],
        text: 'To roll back a release, activate the previous build. Tell the team what changed after the rollback.',
        excerpt: expect.stringContaining('[rollback]'),
        page: null,
        lineStart: 3,
        lineEnd: 5,
        status: 'active',
        authority: 50,
        estimatedTokens: 24,
        title: 'Rollback',
        bm25: expect.any(Number),
      },
    ]);
  });

  it('is idempotent for one namespace when reprojecting nodes and chunks', async () => {
    const buildDirectory = makeBuildDirectory();
    const projection = new DatabaseSync(':memory:');
    databases.push(projection);
    const db = new SqliteProjectionDatabase(projection);
    await runProjectionMigrations(db, () => '2026-08-08T12:00:00.000Z');
    await projectBuildMetadata({
      db,
      projectId: PROJECT,
      buildDirectory,
      projectedAt: '2026-08-08T12:15:00.000Z',
    });

    await projectSearchData({ db, projectId: PROJECT, buildId: BUILD, buildDirectory });
    await projectSearchData({ db, projectId: PROJECT, buildId: BUILD, buildDirectory });

    expect(
      projection
        .prepare('SELECT count(*) AS count FROM nodes WHERE project_id = ? AND build_id = ?')
        .get(PROJECT, BUILD),
    ).toEqual({ count: 2 });
    expect(
      projection
        .prepare('SELECT count(*) AS count FROM chunks WHERE project_id = ? AND build_id = ?')
        .get(PROJECT, BUILD),
    ).toEqual({ count: 1 });
    expect(
      projection
        .prepare('SELECT count(*) AS count FROM chunks_fts WHERE project_id = ? AND build_id = ?')
        .get(PROJECT, BUILD),
    ).toEqual({ count: 1 });
  });
});
