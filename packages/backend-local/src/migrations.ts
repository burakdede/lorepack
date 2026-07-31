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

/**
 * Idempotent and transactional. An applied migration whose file later changes is a
 * hard error: silently diverging schemas are far worse than a loud refusal.
 */
export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  now: () => string = () => new Date().toISOString(),
): MigrationResult {
  db.exec(SCHEMA_TABLE);
  const existing = new Map(
    (
      db.prepare('SELECT id, name, checksum FROM schema_migrations').all() as Array<{
        id: string;
        name: string;
        checksum: string;
      }>
    ).map((row) => [row.id, row]),
  );

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
