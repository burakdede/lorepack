import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BuildManifest, BuildWarning } from '@lorepack/core';
import { afterEach, describe, expect, it } from 'vitest';
import { projectBuildMetadata } from '../src/project-metadata.js';
import {
  type ProjectionMigrationDatabaseLike,
  type ProjectionMigrationStatementLike,
  runProjectionMigrations,
} from '../src/projection-migrations.js';
import { PROJECTION_SCHEMA_VERSION } from '../src/projection-schema.js';

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
  counts: { artifacts: 2, nodes: 3, chunks: 2, tables: 1, tableRows: 3 },
  warnings: [],
};

const WARNINGS: readonly BuildWarning[] = [
  {
    code: 'unsupported-format',
    class: 'unsupported-file',
    path: 'design/logo.psd',
    message: 'Skipped because this format is outside v0.1.',
  },
];

class SqliteProjectionDatabase implements ProjectionMigrationDatabaseLike {
  readonly #db: DatabaseSync;
  readonly #beforeRun?: (query: string, bindings: readonly unknown[]) => void;
  readonly #runDelayMs: number;
  readonly #runBlocker?: (query: string) => Promise<void> | undefined;

  constructor(
    db: DatabaseSync,
    beforeRun?: (query: string, bindings: readonly unknown[]) => void,
    runDelayMs = 0,
    runBlocker?: (query: string) => Promise<void> | undefined,
  ) {
    this.#db = db;
    this.#beforeRun = beforeRun;
    this.#runDelayMs = runDelayMs;
    this.#runBlocker = runBlocker;
  }

  prepare(query: string): ProjectionMigrationStatementLike {
    return new SqliteProjectionStatementWithHook(
      this.#db,
      query,
      this.#beforeRun,
      this.#runDelayMs,
      this.#runBlocker,
    );
  }
}

class SqliteProjectionStatementWithHook implements ProjectionMigrationStatementLike {
  readonly #db: DatabaseSync;
  readonly #query: string;
  readonly #beforeRun?: (query: string, bindings: readonly unknown[]) => void;
  readonly #runDelayMs: number;
  readonly #runBlocker?: (query: string) => Promise<void> | undefined;
  #bindings: readonly unknown[] = [];

  constructor(
    db: DatabaseSync,
    query: string,
    beforeRun?: (query: string, bindings: readonly unknown[]) => void,
    runDelayMs = 0,
    runBlocker?: (query: string) => Promise<void> | undefined,
  ) {
    this.#db = db;
    this.#query = query;
    this.#beforeRun = beforeRun;
    this.#runDelayMs = runDelayMs;
    this.#runBlocker = runBlocker;
  }

  bind(...values: unknown[]): ProjectionMigrationStatementLike {
    this.#bindings = values;
    return this;
  }

  async run<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }> {
    this.#beforeRun?.(this.#query, this.#bindings);
    if (this.#runDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#runDelayMs));
    }
    await this.#runBlocker?.(this.#query);
    const statement = this.#db.prepare(this.#query);
    const trimmed = this.#query.trim().toLowerCase();
    if (trimmed.startsWith('select') || trimmed.startsWith('pragma')) {
      return { results: statement.all(...this.#bindings) as readonly T[] };
    }
    statement.run(...this.#bindings);
    return {};
  }
}

const directories: string[] = [];
const databases: DatabaseSync[] = [];

function trackDatabase(db: DatabaseSync): DatabaseSync {
  databases.push(db);
  return db;
}

function makeBuildDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'lore-build-'));
  directories.push(directory);
  mkdirSync(join(directory, 'reports'));
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  writeFileSync(
    join(directory, 'reports', 'warnings.json'),
    `${JSON.stringify(WARNINGS, null, 2)}\n`,
  );

  const db = trackDatabase(
    new DatabaseSync(join(directory, 'context.sqlite'), {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    }),
  );
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
    `INSERT INTO artifacts
      (id, source_id, relative_path, display_path, media_type, byte_size, content_hash,
       parser_id, parser_version, title, status, authority, object_hash, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'contracted:guides/history.md',
    'guides/history.md',
    'guides/history.md',
    'guides/history.md',
    'text/markdown',
    128,
    '1'.repeat(64),
    'markdown',
    '1.0.0',
    'History',
    'draft',
    20,
    '2'.repeat(64),
    JSON.stringify({ headings: ['History'] }),
  );
  db.prepare('INSERT INTO supersessions (artifact_id, superseded_id) VALUES (?, ?)').run(
    'contracted:guides/rollback.md',
    'contracted:guides/legacy.md',
  );
  db.close();

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

describe('projectBuildMetadata, issue 87', () => {
  it('projects manifest, warnings, artifacts, and supersessions into one namespace', async () => {
    const buildDirectory = makeBuildDirectory();
    const projection = trackDatabase(new DatabaseSync(':memory:'));
    await runProjectionMigrations(
      new SqliteProjectionDatabase(projection),
      () => '2026-08-08T12:00:00.000Z',
    );

    const result = await projectBuildMetadata({
      db: new SqliteProjectionDatabase(projection),
      projectId: PROJECT,
      buildDirectory,
      projectedAt: '2026-08-08T12:30:00.000Z',
    });

    expect(result).toEqual({
      buildId: BUILD,
      projectedArtifacts: 2,
      projectedWarnings: 1,
      projectedSupersessions: 1,
    });

    expect(
      projection
        .prepare(
          'SELECT build_schema_version, compiler_version, projection_schema_version, projected_at, verified_at, activated_at FROM projected_builds WHERE project_id = ? AND build_id = ?',
        )
        .get(PROJECT, BUILD),
    ).toEqual({
      build_schema_version: 1,
      compiler_version: '0.1.0',
      projection_schema_version: PROJECTION_SCHEMA_VERSION,
      projected_at: '2026-08-08T12:30:00.000Z',
      verified_at: null,
      activated_at: null,
    });

    const manifestRow = projection
      .prepare('SELECT manifest_json FROM build_manifests WHERE project_id = ? AND build_id = ?')
      .get(PROJECT, BUILD) as { manifest_json: string };
    expect(JSON.parse(manifestRow.manifest_json)).toEqual(MANIFEST);

    expect(
      projection.prepare('SELECT code, class, path, message FROM build_warnings').all(),
    ).toEqual([
      {
        code: 'unsupported-format',
        class: 'unsupported-file',
        path: 'design/logo.psd',
        message: 'Skipped because this format is outside v0.1.',
      },
    ]);

    expect(
      projection
        .prepare(
          'SELECT id, source_id, relative_path, title, status, authority, metadata_json FROM artifacts WHERE project_id = ? AND build_id = ? ORDER BY id',
        )
        .all(PROJECT, BUILD),
    ).toEqual([
      {
        id: 'contracted:guides/history.md',
        source_id: 'guides/history.md',
        relative_path: 'guides/history.md',
        title: 'History',
        status: 'draft',
        authority: 20,
        metadata_json: '{"headings":["History"]}',
      },
      {
        id: 'contracted:guides/rollback.md',
        source_id: 'guides/rollback.md',
        relative_path: 'guides/rollback.md',
        title: 'Rollback',
        status: 'active',
        authority: 50,
        metadata_json: '{"headings":["Rollback"]}',
      },
    ]);

    expect(
      projection
        .prepare(
          'SELECT artifact_id, superseded_id FROM supersessions WHERE project_id = ? AND build_id = ?',
        )
        .all(PROJECT, BUILD),
    ).toEqual([
      {
        artifact_id: 'contracted:guides/rollback.md',
        superseded_id: 'contracted:guides/legacy.md',
      },
    ]);
  });

  it('is idempotent for one namespace and leaves other namespaces untouched', async () => {
    const buildDirectory = makeBuildDirectory();
    const projection = trackDatabase(new DatabaseSync(':memory:'));
    await runProjectionMigrations(
      new SqliteProjectionDatabase(projection),
      () => '2026-08-08T12:00:00.000Z',
    );

    projection
      .prepare('INSERT INTO build_manifests (project_id, build_id, manifest_json) VALUES (?, ?, ?)')
      .run('other', 'lore_other', '{"formatVersion":1}');

    await projectBuildMetadata({
      db: new SqliteProjectionDatabase(projection),
      projectId: PROJECT,
      buildDirectory,
      projectedAt: '2026-08-08T12:30:00.000Z',
    });

    const writable = trackDatabase(
      new DatabaseSync(join(buildDirectory, 'context.sqlite'), {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
      }),
    );
    writable
      .prepare('UPDATE artifacts SET title = ? WHERE id = ?')
      .run('Rollback Updated', 'contracted:guides/rollback.md');
    writable.close();
    databases.pop();

    await projectBuildMetadata({
      db: new SqliteProjectionDatabase(projection),
      projectId: PROJECT,
      buildDirectory,
      projectedAt: '2026-08-08T12:45:00.000Z',
    });

    expect(
      projection
        .prepare('SELECT count(*) AS count FROM artifacts WHERE project_id = ? AND build_id = ?')
        .get(PROJECT, BUILD),
    ).toEqual({ count: 2 });
    expect(
      projection
        .prepare(
          'SELECT count(*) AS count FROM build_warnings WHERE project_id = ? AND build_id = ?',
        )
        .get(PROJECT, BUILD),
    ).toEqual({ count: 1 });
    expect(
      projection
        .prepare('SELECT title FROM artifacts WHERE project_id = ? AND build_id = ? AND id = ?')
        .get(PROJECT, BUILD, 'contracted:guides/rollback.md'),
    ).toEqual({ title: 'Rollback Updated' });
    expect(
      projection
        .prepare('SELECT count(*) AS count FROM build_manifests WHERE project_id = ?')
        .get('other'),
    ).toEqual({ count: 1 });
  });

  it('retries transient metadata write failures and reports batch progress', async () => {
    const buildDirectory = makeBuildDirectory();
    const projection = trackDatabase(new DatabaseSync(':memory:'));
    await runProjectionMigrations(
      new SqliteProjectionDatabase(projection),
      () => '2026-08-08T12:00:00.000Z',
    );

    let failures = 0;
    const updates: Array<{ completedBatches: number; totalBatches: number; detail: string }> = [];
    const db = new SqliteProjectionDatabase(projection, (query) => {
      if (query.startsWith('INSERT INTO artifacts') && failures === 0) {
        failures += 1;
        throw new Error('database is locked');
      }
    });

    const result = await projectBuildMetadata({
      db,
      projectId: PROJECT,
      buildDirectory,
      projectedAt: '2026-08-08T13:00:00.000Z',
      retryDelayMs: 0,
      sleep: async () => {},
      onProgress: (update) => {
        updates.push(update);
      },
    });

    expect(failures).toBe(1);
    expect(result).toEqual({
      buildId: BUILD,
      projectedArtifacts: 2,
      projectedWarnings: 1,
      projectedSupersessions: 1,
    });
    expect(updates.at(-1)).toEqual({
      completedBatches: 11,
      totalBatches: 11,
      detail: 'insert supersession contracted:guides/rollback.md',
    });
  });

  it('emits repeated progress updates during a slow metadata batch', async () => {
    const buildDirectory = makeBuildDirectory();
    const projection = trackDatabase(new DatabaseSync(':memory:'));
    await runProjectionMigrations(
      new SqliteProjectionDatabase(projection),
      () => '2026-08-08T12:00:00.000Z',
    );

    let resolveBatch: (() => void) | undefined;
    const batchBlocker = new Promise<void>((resolve) => {
      resolveBatch = resolve;
    });
    const updates: Array<{ completedBatches: number; totalBatches: number; detail: string }> = [];

    const resultPromise = projectBuildMetadata({
      db: new SqliteProjectionDatabase(projection, undefined, 0, (query) => {
        return query === 'BEGIN IMMEDIATE' ? undefined : batchBlocker;
      }),
      projectId: PROJECT,
      buildDirectory,
      projectedAt: '2026-08-08T13:00:00.000Z',
      progressIntervalMs: 25,
      onProgress: (update) => {
        updates.push(update);
        if (updates.filter((entry) => entry.completedBatches === 0).length === 3) {
          resolveBatch?.();
        }
      },
    });

    await resultPromise;

    expect(updates.filter((update) => update.completedBatches === 0).length).toBeGreaterThanOrEqual(
      3,
    );
    expect(updates.at(-1)).toEqual({
      completedBatches: 11,
      totalBatches: 11,
      detail: 'insert supersession contracted:guides/rollback.md',
    });
  });
});
