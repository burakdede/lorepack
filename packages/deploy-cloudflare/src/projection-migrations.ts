import { createHash } from 'node:crypto';
import { PROJECTION_SCHEMA_VERSION } from './projection-schema.js';

/**
 * The D1 projection schema for Phase 6.
 *
 * This module is Node-side deployment code, not Worker runtime code. The Worker reads the
 * projected tables through `catalog.ts`, `tables.ts`, and `storage.ts`; the deploy path owns
 * creating those tables and recording which projection schema wrote them.
 */

export interface ProjectionMigrationStatementLike {
  bind(...values: unknown[]): ProjectionMigrationStatementLike;
  run<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }>;
}

export interface ProjectionMigrationDatabaseLike {
  prepare(query: string): ProjectionMigrationStatementLike;
}

export interface ProjectionMigration {
  readonly id: string;
  readonly name: string;
  readonly statements: readonly string[];
  readonly checksum: string;
}

export interface ProjectionMigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

interface AppliedMigrationRow {
  readonly id: string;
  readonly checksum: string;
}

const SCHEMA_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

const PROJECTION_MIGRATIONS_SOURCE = [
  {
    id: '0001',
    name: 'projection-catalog',
    statements: [
      `CREATE TABLE IF NOT EXISTS active_build (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  build_id TEXT,
  generation INTEGER NOT NULL
)`,
      `INSERT OR IGNORE INTO active_build (id, build_id, generation) VALUES (1, NULL, 0)`,
      `CREATE TABLE IF NOT EXISTS projected_builds (
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  build_schema_version INTEGER NOT NULL,
  compiler_version TEXT NOT NULL,
  projection_schema_version INTEGER NOT NULL,
  projected_at TEXT NOT NULL,
  PRIMARY KEY (project_id, build_id)
)`,
      `CREATE TABLE IF NOT EXISTS build_manifests (
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  PRIMARY KEY (project_id, build_id)
)`,
      `CREATE TABLE IF NOT EXISTS build_warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  code TEXT NOT NULL,
  class TEXT NOT NULL,
  path TEXT,
  message TEXT NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  source_id TEXT,
  relative_path TEXT NOT NULL,
  display_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER,
  content_hash TEXT,
  parser_id TEXT,
  parser_version TEXT,
  title TEXT,
  status TEXT NOT NULL,
  authority INTEGER NOT NULL,
  object_hash TEXT NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY (project_id, build_id, id)
)`,
      `CREATE TABLE IF NOT EXISTS supersessions (
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  superseded_id TEXT NOT NULL,
  PRIMARY KEY (project_id, build_id, artifact_id, superseded_id)
)`,
      `CREATE TABLE IF NOT EXISTS nodes (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT,
  text TEXT,
  heading_path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  metadata_json TEXT,
  revision_hash TEXT,
  PRIMARY KEY (project_id, build_id, id)
)`,
      `CREATE TABLE IF NOT EXISTS chunks (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  node_ids TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  text TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  page INTEGER,
  revision_hash TEXT,
  PRIMARY KEY (project_id, build_id, id)
)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  project_id UNINDEXED,
  build_id UNINDEXED,
  chunk_id UNINDEXED,
  artifact_id UNINDEXED,
  status,
  authority,
  path,
  title,
  heading,
  body
)`,
      `CREATE TABLE IF NOT EXISTS tables (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sheet TEXT,
  sql_name TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  cell_range TEXT,
  metadata_json TEXT,
  PRIMARY KEY (project_id, build_id, id)
)`,
      `CREATE TABLE IF NOT EXISTS table_columns (
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
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
  PRIMARY KEY (project_id, build_id, table_id, ordinal)
)`,
    ],
  },
] as const;

export const PROJECTION_MIGRATIONS: readonly ProjectionMigration[] =
  PROJECTION_MIGRATIONS_SOURCE.map((migration) => ({
    ...migration,
    checksum: createHash('sha256')
      .update(migration.statements.join('\n-- statement --\n'))
      .digest('hex'),
  }));

export { PROJECTION_SCHEMA_VERSION };

export async function runProjectionMigrations(
  db: ProjectionMigrationDatabaseLike,
  now: () => string = () => new Date().toISOString(),
): Promise<ProjectionMigrationResult> {
  await db.prepare(SCHEMA_MIGRATIONS_TABLE).run();

  const existingRows = await db
    .prepare('SELECT id, checksum FROM schema_migrations ORDER BY id')
    .run<AppliedMigrationRow>();
  const existing = new Map((existingRows.results ?? []).map((row) => [row.id, row.checksum]));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  for (const migration of PROJECTION_MIGRATIONS) {
    const previous = existing.get(migration.id);
    if (previous !== undefined) {
      if (previous !== migration.checksum) {
        throw new Error(
          `Projection migration ${migration.id}_${migration.name} changed after it was applied.`,
        );
      }
      alreadyApplied.push(migration.id);
      continue;
    }

    for (const statement of migration.statements) {
      await db.prepare(statement).run();
    }
    await db
      .prepare('INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .bind(migration.id, migration.name, migration.checksum, now())
      .run();
    applied.push(migration.id);
  }

  return { applied, alreadyApplied };
}
