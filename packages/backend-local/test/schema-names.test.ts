import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { loadMigrations, runMigrations } from '../src/migrations.js';
import { buildMigrationsDirectory } from '../src/migrations-path.js';
import { BUILD_SCHEMA_OBJECTS } from '../src/sql/schema-names.js';

/**
 * The statement guard refuses every name in this list (#406). A migration that adds a table,
 * an index or a full-text shadow table must add it here, or a table query could name it; this
 * test is what makes forgetting that a failure instead of an exposure.
 */
describe('the fixed objects of a build database', () => {
  it('lists every object the build migrations create', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, loadMigrations(buildMigrationsDirectory()), () => '2026-01-01T00:00:00.000Z');

    const created = (db.prepare('SELECT name FROM sqlite_master').all() as { name: string }[])
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_'))
      .sort();
    db.close();

    expect([...BUILD_SCHEMA_OBJECTS].sort()).toEqual(created);
  });
});
