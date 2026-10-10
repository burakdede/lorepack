import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { LoreError } from '@lorepack/core';

/**
 * Raw SQL migrations, applied in order inside a transaction. No ORM in v0.1: versioned
 * SQL is inspectable, reviewable, and shares its semantics with the D1 projection.
 */

export interface Migration {
  readonly id: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9-]+)\.sql$/;

export function loadMigrations(directory: string): Migration[] {
  if (!existsSync(directory)) return [];
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const migrations: Migration[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (match === null) {
      throw new LoreError('LORE_E_INTERNAL', `Migration file name is malformed: ${file}`, {
        remediation:
          'Name migrations NNNN_lowercase-with-dashes.sql, for example 0001_catalog.sql.',
      });
    }
    const id = match[1] as string;
    if (seen.has(id)) {
      throw new LoreError('LORE_E_INTERNAL', `Duplicate migration number ${id}.`, {
        remediation: 'Migration numbers must be unique and sequential.',
      });
    }
    seen.add(id);
    const sql = readFileSync(join(directory, file), 'utf8');
    migrations.push({
      id,
      name: match[2] as string,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations;
}

const SCHEMA_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  checksum  TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT
`;

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

interface AppliedMigration {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
}

function appliedMigrations(db: DatabaseSync): AppliedMigration[] {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (table === undefined) return [];
  return db
    .prepare('SELECT id, name, checksum FROM schema_migrations ORDER BY id')
    .all() as unknown as AppliedMigration[];
}

/**
 * Refuses a database that records a migration this binary does not ship (#570).
 *
 * Such a database was written by a newer Lorepack. Reading it may misread a table this code
 * has never heard of, and writing it can break a rule the newer version depends on: a v0.1
 * prune deleting a build a later version pinned. Failing closed is the only safe answer, and
 * it only protects anyone if the oldest binary in circulation already does it, which is why
 * it exists before there is a second migration to guard.
 *
 * Reads only, so a caller can run it on a read-only connection before opening for writing.
 */
export function assertMigrationsKnown(db: DatabaseSync, migrations: readonly Migration[]): void {
  const known = new Set(migrations.map((migration) => migration.id));
  const unknown = appliedMigrations(db).filter((row) => !known.has(row.id));
  if (unknown.length === 0) return;

  const latest = migrations.reduce((highest, one) => (one.id > highest ? one.id : highest), '0000');
  throw new LoreError(
    'LORE_E_SCHEMA_MISMATCH',
    `This database records ${unknown.map((row) => `${row.id}_${row.name}`).join(', ')}, a schema written by a newer Lorepack. This version knows migrations up to ${latest}.`,
    {
      remediation:
        'Upgrade Lorepack to the version that last wrote this project. Nothing was changed.',
      details: { unknown: unknown.map((row) => row.id), latest },
    },
  );
}

/**
 * Idempotent and transactional. An applied migration whose file later changes is a
 * hard error: silently diverging schemas are far worse than a loud refusal. So is one this
 * binary does not know at all, checked before anything is applied.
 */
export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  now: () => string = () => new Date().toISOString(),
): MigrationResult {
  assertMigrationsKnown(db, migrations);
  db.exec(SCHEMA_TABLE);
  const existing = new Map(appliedMigrations(db).map((row) => [row.id, row]));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of migrations) {
    const previous = existing.get(migration.id);
    if (previous !== undefined) {
      if (previous.checksum !== migration.checksum) {
        throw new LoreError(
          'LORE_E_INTERNAL',
          `Migration ${migration.id}_${migration.name} changed after it was applied.`,
          {
            remediation:
              'Never edit an applied migration. Add a new one, or delete the database if it is a disposable candidate build.',
            details: { expected: previous.checksum, actual: migration.checksum },
          },
        );
      }
      alreadyApplied.push(migration.id);
      continue;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(migration.id, migration.name, migration.checksum, now());
      db.exec('COMMIT');
      applied.push(migration.id);
    } catch (cause) {
      db.exec('ROLLBACK');
      throw new LoreError(
        'LORE_E_INTERNAL',
        `Migration ${migration.id}_${migration.name} failed and was rolled back.`,
        { remediation: 'Fix the migration SQL. The database is unchanged.', cause },
      );
    }
  }

  return { applied, alreadyApplied };
}
