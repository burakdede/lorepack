import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROJECTION_MIGRATIONS,
  PROJECTION_SCHEMA_VERSION,
  type ProjectionMigrationDatabaseLike,
  type ProjectionMigrationStatementLike,
  runProjectionMigrations,
} from '../src/projection-migrations.js';

class SqliteProjectionStatement implements ProjectionMigrationStatementLike {
  readonly #db: DatabaseSync;
  readonly #query: string;
  #bindings: readonly unknown[] = [];

  constructor(db: DatabaseSync, query: string) {
    this.#db = db;
    this.#query = query;
  }

  bind(...values: unknown[]): ProjectionMigrationStatementLike {
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
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  prepare(query: string): ProjectionMigrationStatementLike {
    return new SqliteProjectionStatement(this.#db, query);
  }
}

const databases: DatabaseSync[] = [];

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  return db;
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
});

describe('projection migrations, issue 87', () => {
  it('create the checked-in D1 projection schema and seed the active pointer row', async () => {
    const db = openDatabase();
    const projection = new SqliteProjectionDatabase(db);

    const result = await runProjectionMigrations(projection, () => '2026-08-08T12:00:00.000Z');
    expect(result).toEqual({ applied: ['0001'], alreadyApplied: [] });

    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'active_build',
        'artifacts',
        'build_manifests',
        'build_warnings',
        'chunks',
        'chunks_fts',
        'nodes',
        'projected_builds',
        'schema_migrations',
        'supersessions',
        'table_columns',
        'tables',
      ]),
    );

    const active = db
      .prepare('SELECT build_id, generation FROM active_build WHERE id = 1')
      .get() as {
      build_id: string | null;
      generation: number;
    };
    expect(active).toEqual({ build_id: null, generation: 0 });

    const projectedColumns = (
      db.prepare('PRAGMA table_info(projected_builds)').all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(projectedColumns).toEqual(
      expect.arrayContaining([
        'project_id',
        'build_id',
        'build_schema_version',
        'compiler_version',
        'projection_schema_version',
        'projected_at',
      ]),
    );
  });

  it('are idempotent and record the checked-in checksum once', async () => {
    const db = openDatabase();
    const projection = new SqliteProjectionDatabase(db);

    await runProjectionMigrations(projection, () => '2026-08-08T12:00:00.000Z');
    const second = await runProjectionMigrations(projection, () => '2026-08-08T12:05:00.000Z');
    expect(second).toEqual({ applied: [], alreadyApplied: ['0001'] });

    const rows = db
      .prepare('SELECT id, checksum FROM schema_migrations ORDER BY id')
      .all() as Array<{
      id: string;
      checksum: string;
    }>;
    expect(rows).toEqual([
      {
        id: '0001',
        checksum: PROJECTION_MIGRATIONS[0]?.checksum ?? '',
      },
    ]);
    expect(PROJECTION_SCHEMA_VERSION).toBe(1);
  });
});
