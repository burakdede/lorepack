import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ProjectionMigrationDatabaseLike,
  type ProjectionMigrationStatementLike,
  runProjectionMigrations,
} from '../src/projection-migrations.js';
import { r2ArchiveKey, r2ObjectKey } from '../src/r2-keys.js';
import { planRemoteRetention } from '../src/retention.js';

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
});
