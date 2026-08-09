import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ProjectionMigrationDatabaseLike,
  type ProjectionMigrationStatementLike,
  runProjectionMigrations,
} from '../src/projection-migrations.js';
import { r2ArchiveKey, r2ObjectKey } from '../src/r2-keys.js';
import {
  applyRemoteRetention,
  applyRemoteRetentionPlan,
  planRemoteRetention,
  RemoteRetentionApplyError,
} from '../src/retention.js';

class SqliteStatement implements ProjectionMigrationStatementLike {
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

class SqliteProjectionDatabase implements ProjectionMigrationDatabaseLike {
  readonly raw: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.raw = db;
  }

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this.raw, query);
  }
}

const databases: DatabaseSync[] = [];

function openDatabase(): SqliteProjectionDatabase {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  return new SqliteProjectionDatabase(db);
}

class FakeR2Bucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly deletedKeys: string[] = [];
  failOnDeleteKey: string | null = null;

  async put(key: string, value: Uint8Array): Promise<void> {
    this.objects.set(key, value);
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

  async delete(key: string): Promise<void> {
    if (this.failOnDeleteKey === key) {
      throw new Error(`Refused delete for ${key}`);
    }
    this.objects.delete(key);
    this.deletedKeys.push(key);
  }
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
});

describe('remote retention planning, issue 92', () => {
  it('keeps the active build and the previous five verified builds, excluding projected-only candidates', async () => {
    const db = openDatabase();
    await runProjectionMigrations(db, () => '2026-08-09T12:00:00.000Z');

    db.raw
      .prepare('UPDATE active_build SET build_id = ?, generation = ? WHERE id = 1')
      .run(`lore_${'f'.repeat(64)}`, 7);

    const rows = [
      [`lore_${'9'.repeat(64)}`, '2026-08-09T12:07:00.000Z', null],
      [`lore_${'f'.repeat(64)}`, '2026-08-09T12:06:00.000Z', '2026-08-09T12:06:30.000Z'],
      [`lore_${'e'.repeat(64)}`, '2026-08-09T12:05:00.000Z', '2026-08-09T12:05:30.000Z'],
      [`lore_${'d'.repeat(64)}`, '2026-08-09T12:04:00.000Z', '2026-08-09T12:04:30.000Z'],
      [`lore_${'c'.repeat(64)}`, '2026-08-09T12:03:00.000Z', '2026-08-09T12:03:30.000Z'],
      [`lore_${'b'.repeat(64)}`, '2026-08-09T12:02:00.000Z', '2026-08-09T12:02:30.000Z'],
      [`lore_${'a'.repeat(64)}`, '2026-08-09T12:01:00.000Z', '2026-08-09T12:01:30.000Z'],
      [`lore_${'0'.repeat(64)}`, '2026-08-09T12:00:00.000Z', '2026-08-09T12:00:30.000Z'],
    ] as const;
    for (const [buildId, projectedAt, verifiedAt] of rows) {
      db.raw
        .prepare(
          `INSERT INTO projected_builds
            (project_id, build_id, build_schema_version, compiler_version, projection_schema_version, projected_at, verified_at, activated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('demo', buildId, 1, '0.1.0', 4, projectedAt, verifiedAt, verifiedAt);
    }

    const plan = await planRemoteRetention(db, 'demo', 5);

    expect(plan.activeBuildId).toBe(`lore_${'f'.repeat(64)}`);
    expect(plan.keep).toEqual([
      `lore_${'f'.repeat(64)}`,
      `lore_${'e'.repeat(64)}`,
      `lore_${'d'.repeat(64)}`,
      `lore_${'c'.repeat(64)}`,
      `lore_${'b'.repeat(64)}`,
      `lore_${'a'.repeat(64)}`,
    ]);
    expect(plan.remove).toEqual([`lore_${'9'.repeat(64)}`, `lore_${'0'.repeat(64)}`]);
    expect(plan.archiveKeysToRemove).toEqual([
      r2ArchiveKey('demo', `lore_${'9'.repeat(64)}`),
      r2ArchiveKey('demo', `lore_${'0'.repeat(64)}`),
    ]);
  });

  it('never schedules a shared object for deletion while a retained verified build still references it', async () => {
    const db = openDatabase();
    await runProjectionMigrations(db, () => '2026-08-09T12:00:00.000Z');

    db.raw
      .prepare('UPDATE active_build SET build_id = ?, generation = ? WHERE id = 1')
      .run(`lore_${'c'.repeat(64)}`, 4);

    for (const [buildId, projectedAt, verifiedAt] of [
      [`lore_${'d'.repeat(64)}`, '2026-08-09T12:03:00.000Z', null],
      [`lore_${'c'.repeat(64)}`, '2026-08-09T12:02:00.000Z', '2026-08-09T12:02:30.000Z'],
      [`lore_${'b'.repeat(64)}`, '2026-08-09T12:01:00.000Z', '2026-08-09T12:01:30.000Z'],
      [`lore_${'a'.repeat(64)}`, '2026-08-09T12:00:00.000Z', '2026-08-09T12:00:30.000Z'],
    ] as const) {
      db.raw
        .prepare(
          `INSERT INTO projected_builds
            (project_id, build_id, build_schema_version, compiler_version, projection_schema_version, projected_at, verified_at, activated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('demo', buildId, 1, '0.1.0', 4, projectedAt, verifiedAt, verifiedAt);
    }

    db.raw
      .prepare(
        `INSERT INTO artifacts
        (id, project_id, build_id, source_id, relative_path, display_path, media_type, byte_size,
         content_hash, parser_id, parser_version, title, status, authority, object_hash, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'keep-artifact',
        'demo',
        `lore_${'a'.repeat(64)}`,
        'keep.md',
        'keep.md',
        'keep.md',
        'text/markdown',
        10,
        '1'.repeat(64),
        'markdown',
        '1.0.0',
        'Keep',
        'active',
        50,
        'shared'.padEnd(64, 's'),
        '{}',
      );
    db.raw
      .prepare(
        `INSERT INTO artifacts
        (id, project_id, build_id, source_id, relative_path, display_path, media_type, byte_size,
         content_hash, parser_id, parser_version, title, status, authority, object_hash, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'remove-artifact-shared',
        'demo',
        `lore_${'d'.repeat(64)}`,
        'remove.md',
        'remove.md',
        'remove.md',
        'text/markdown',
        10,
        '2'.repeat(64),
        'markdown',
        '1.0.0',
        'Remove shared',
        'active',
        50,
        'shared'.padEnd(64, 's'),
        '{}',
      );
    db.raw
      .prepare(
        `INSERT INTO artifacts
        (id, project_id, build_id, source_id, relative_path, display_path, media_type, byte_size,
         content_hash, parser_id, parser_version, title, status, authority, object_hash, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'remove-artifact-unique',
        'demo',
        `lore_${'d'.repeat(64)}`,
        'unique.md',
        'unique.md',
        'unique.md',
        'text/markdown',
        10,
        '3'.repeat(64),
        'markdown',
        '1.0.0',
        'Remove unique',
        'active',
        50,
        'unique'.padEnd(64, 'u'),
        '{}',
      );

    const plan = await planRemoteRetention(db, 'demo', 2);

    expect(plan.remove).toEqual([`lore_${'d'.repeat(64)}`]);
    expect(plan.objectKeysToRemove).toEqual([r2ObjectKey('demo', 'unique'.padEnd(64, 'u'))]);
    expect(plan.objectKeysToRemove).not.toContain(r2ObjectKey('demo', 'shared'.padEnd(64, 's')));
  });

  it('applies remote cleanup to D1 and R2 and reports exact removals', async () => {
    const db = openDatabase();
    const bucket = new FakeR2Bucket();
    await runProjectionMigrations(db, () => '2026-08-09T12:00:00.000Z');

    db.raw
      .prepare('UPDATE active_build SET build_id = ?, generation = ? WHERE id = 1')
      .run(`lore_${'b'.repeat(64)}`, 3);

    for (const [buildId, projectedAt, verifiedAt] of [
      [`lore_${'c'.repeat(64)}`, '2026-08-09T12:02:00.000Z', null],
      [`lore_${'b'.repeat(64)}`, '2026-08-09T12:01:00.000Z', '2026-08-09T12:01:30.000Z'],
      [`lore_${'a'.repeat(64)}`, '2026-08-09T12:00:00.000Z', '2026-08-09T12:00:30.000Z'],
    ] as const) {
      db.raw
        .prepare(
          `INSERT INTO projected_builds
            (project_id, build_id, build_schema_version, compiler_version, projection_schema_version, projected_at, verified_at, activated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('demo', buildId, 1, '0.1.0', 4, projectedAt, verifiedAt, verifiedAt);
    }

    db.raw
      .prepare('INSERT INTO build_manifests (project_id, build_id, manifest_json) VALUES (?, ?, ?)')
      .run('demo', `lore_${'c'.repeat(64)}`, '{"build":"remove"}');
    db.raw
      .prepare(
        `INSERT INTO build_warnings (project_id, build_id, code, class, path, message)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('demo', `lore_${'c'.repeat(64)}`, 'warn', 'parser', 'remove.md', 'warning');
    db.raw
      .prepare(
        `INSERT INTO artifacts
        (id, project_id, build_id, source_id, relative_path, display_path, media_type, byte_size,
         content_hash, parser_id, parser_version, title, status, authority, object_hash, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'remove-artifact',
        'demo',
        `lore_${'c'.repeat(64)}`,
        'remove.md',
        'remove.md',
        'remove.md',
        'text/markdown',
        10,
        '3'.repeat(64),
        'markdown',
        '1.0.0',
        'Remove unique',
        'active',
        50,
        'unique'.padEnd(64, 'u'),
        '{}',
      );
    db.raw
      .prepare(
        `INSERT INTO artifacts
        (id, project_id, build_id, source_id, relative_path, display_path, media_type, byte_size,
         content_hash, parser_id, parser_version, title, status, authority, object_hash, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'keep-artifact',
        'demo',
        `lore_${'a'.repeat(64)}`,
        'keep.md',
        'keep.md',
        'keep.md',
        'text/markdown',
        10,
        '1'.repeat(64),
        'markdown',
        '1.0.0',
        'Keep',
        'active',
        50,
        'shared'.padEnd(64, 's'),
        '{}',
      );
    db.raw
      .prepare(
        'INSERT INTO supersessions (project_id, build_id, artifact_id, superseded_id) VALUES (?, ?, ?, ?)',
      )
      .run('demo', `lore_${'c'.repeat(64)}`, 'remove-artifact', 'older');
    db.raw
      .prepare(
        `INSERT INTO nodes
          (id, project_id, build_id, artifact_id, parent_id, kind, ordinal, title, text, heading_path, line_start, line_end, metadata_json, revision_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'node-remove',
        'demo',
        `lore_${'c'.repeat(64)}`,
        'remove-artifact',
        null,
        'paragraph',
        0,
        'Title',
        'Body',
        '[]',
        1,
        1,
        '{}',
        'r'.repeat(64),
      );
    db.raw
      .prepare(
        `INSERT INTO chunks
          (id, project_id, build_id, artifact_id, node_ids, heading_path, text, estimated_tokens, relative_path, line_start, line_end, page, revision_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'chunk-remove',
        'demo',
        `lore_${'c'.repeat(64)}`,
        'remove-artifact',
        '["node-remove"]',
        '[]',
        'Body',
        3,
        'remove.md',
        1,
        1,
        null,
        'r'.repeat(64),
      );
    db.raw
      .prepare(
        `INSERT INTO chunks_fts
          (project_id, build_id, chunk_id, artifact_id, status, authority, path, title, heading, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'demo',
        `lore_${'c'.repeat(64)}`,
        'chunk-remove',
        'remove-artifact',
        'active',
        '50',
        'remove.md',
        'Remove unique',
        'Heading',
        'Body',
      );
    db.raw
      .prepare(
        `INSERT INTO tables
          (id, project_id, build_id, artifact_id, name, sheet, sql_name, row_count, relative_path, line_start, line_end, cell_range, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'table-remove',
        'demo',
        `lore_${'c'.repeat(64)}`,
        'remove-artifact',
        'Budget',
        'Sheet1',
        'projected_demo_remove',
        1,
        'remove.csv',
        1,
        2,
        'A1:B2',
        '{}',
      );
    db.raw
      .prepare(
        `INSERT INTO table_columns
          (project_id, build_id, table_id, ordinal, name, sql_name, type, nullable, null_count, distinct_estimate, distinct_is_exact, min_value, max_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'demo',
        `lore_${'c'.repeat(64)}`,
        'table-remove',
        0,
        'amount',
        'amount',
        'TEXT',
        0,
        0,
        1,
        1,
        '1',
        '1',
      );
    db.raw.exec('CREATE TABLE projected_demo_remove (amount TEXT NOT NULL)');

    const removeArchiveKey = r2ArchiveKey('demo', `lore_${'c'.repeat(64)}`);
    const removeObjectKey = r2ObjectKey('demo', 'unique'.padEnd(64, 'u'));
    await bucket.put(removeArchiveKey, new Uint8Array([1]));
    await bucket.put(removeObjectKey, new Uint8Array([2]));

    const result = await applyRemoteRetention(db, bucket, 'demo', 2);

    expect(result.remove).toEqual([`lore_${'c'.repeat(64)}`]);
    expect(result.d1).toEqual({
      projectedBuildsRemoved: 1,
      buildManifestsRemoved: 1,
      buildWarningsRemoved: 1,
      artifactsRemoved: 1,
      supersessionsRemoved: 1,
      nodesRemoved: 1,
      chunksRemoved: 1,
      ftsRowsRemoved: 1,
      projectedTablesRemoved: 1,
      projectedTableColumnsRemoved: 1,
      physicalTablesDropped: ['projected_demo_remove'],
    });
    expect(result.r2.archiveKeysRemoved).toEqual([removeArchiveKey]);
    expect(result.r2.objectKeysRemoved).toEqual([removeObjectKey]);
    expect(
      db.raw
        .prepare('SELECT count(*) AS count FROM projected_builds WHERE project_id = ?')
        .get('demo'),
    ).toEqual({ count: 2 });
    expect(
      db.raw
        .prepare('SELECT count(*) AS count FROM artifacts WHERE project_id = ? AND build_id = ?')
        .get('demo', `lore_${'c'.repeat(64)}`),
    ).toEqual({ count: 0 });
    expect(
      db.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projected_demo_remove'",
        )
        .get(),
    ).toBeUndefined();
    expect(await bucket.head(removeArchiveKey)).toBeNull();
    expect(await bucket.head(removeObjectKey)).toBeNull();
  });

  it('resumes a failed remote cleanup without repeating completed deletions', async () => {
    const db = openDatabase();
    const bucket = new FakeR2Bucket();
    await runProjectionMigrations(db, () => '2026-08-09T12:00:00.000Z');

    db.raw
      .prepare('UPDATE active_build SET build_id = ?, generation = ? WHERE id = 1')
      .run(`lore_${'b'.repeat(64)}`, 3);
    for (const [buildId, projectedAt, verifiedAt] of [
      [`lore_${'c'.repeat(64)}`, '2026-08-09T12:02:00.000Z', null],
      [`lore_${'b'.repeat(64)}`, '2026-08-09T12:01:00.000Z', '2026-08-09T12:01:30.000Z'],
      [`lore_${'a'.repeat(64)}`, '2026-08-09T12:00:00.000Z', '2026-08-09T12:00:30.000Z'],
    ] as const) {
      db.raw
        .prepare(
          `INSERT INTO projected_builds
            (project_id, build_id, build_schema_version, compiler_version, projection_schema_version, projected_at, verified_at, activated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('demo', buildId, 1, '0.1.0', 4, projectedAt, verifiedAt, verifiedAt);
    }
    db.raw
      .prepare('INSERT INTO build_manifests (project_id, build_id, manifest_json) VALUES (?, ?, ?)')
      .run('demo', `lore_${'c'.repeat(64)}`, '{"build":"remove"}');
    db.raw
      .prepare(
        `INSERT INTO artifacts
        (id, project_id, build_id, source_id, relative_path, display_path, media_type, byte_size,
         content_hash, parser_id, parser_version, title, status, authority, object_hash, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'remove-artifact',
        'demo',
        `lore_${'c'.repeat(64)}`,
        'remove.md',
        'remove.md',
        'remove.md',
        'text/markdown',
        10,
        '3'.repeat(64),
        'markdown',
        '1.0.0',
        'Remove unique',
        'active',
        50,
        'unique'.padEnd(64, 'u'),
        '{}',
      );

    const plan = await planRemoteRetention(db, 'demo', 2);
    const archiveKey = r2ArchiveKey('demo', `lore_${'c'.repeat(64)}`);
    const objectKey = r2ObjectKey('demo', 'unique'.padEnd(64, 'u'));
    await bucket.put(archiveKey, new Uint8Array([1]));
    await bucket.put(objectKey, new Uint8Array([2]));
    bucket.failOnDeleteKey = objectKey;

    const first = await applyRemoteRetentionPlan(db, bucket, plan).catch((error: unknown) => error);

    expect(first).toBeInstanceOf(RemoteRetentionApplyError);
    const failure = first as RemoteRetentionApplyError;
    expect(failure.progress.d1Completed).toBe(true);
    expect(failure.progress.archivesCompleted).toBe(true);
    expect(failure.progress.objectsCompleted).toBe(false);
    expect(failure.progress.archiveKeysRemoved).toEqual([archiveKey]);
    expect(failure.progress.objectKeysRemoved).toEqual([]);
    expect(bucket.deletedKeys).toEqual([archiveKey]);

    bucket.failOnDeleteKey = null;
    const resumed = await applyRemoteRetentionPlan(db, bucket, plan, failure.progress);

    expect(resumed.r2.archiveKeysRemoved).toEqual([archiveKey]);
    expect(resumed.r2.objectKeysRemoved).toEqual([objectKey]);
    expect(bucket.deletedKeys).toEqual([archiveKey, objectKey]);
  });
});
