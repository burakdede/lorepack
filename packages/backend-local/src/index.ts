export { assertFts5Available, type Fts5ProbeResult, probeFts5 } from './fts5.js';
export {
  loadMigrations,
  type Migration,
  type MigrationResult,
  runMigrations,
} from './migrations.js';
export {
  assertSqliteApiSurface,
  integrityCheck,
  type OpenOptions,
  openReadOnly,
  openWritable,
  restrictToTables,
  SAFE_QUERY_LIMITS,
  type SqliteLimits,
  sqliteVersion,
} from './sqlite.js';
