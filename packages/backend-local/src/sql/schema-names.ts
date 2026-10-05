/**
 * Every fixed object in a build database, for the statement guard (#406).
 *
 * The guard refuses any token that names another object in the database. The query path runs
 * on a connection whose authorizer does not admit `sqlite_master`, so the fixed names are
 * listed here and the build's own physical tables are added per query from the catalog.
 * `schema-names.test.ts` compares this list with a real build, so a migration that adds an
 * object fails a test instead of quietly leaving it nameable.
 *
 * `sqlite_*` objects (autoindexes, the schema table itself) are refused by family in the guard
 * and need no entry.
 */
export const BUILD_SCHEMA_OBJECTS: readonly string[] = [
  'artifacts',
  'artifacts_path',
  'artifacts_status',
  'build_warnings',
  'chunks',
  'chunks_artifact',
  'chunks_fts',
  'chunks_fts_config',
  'chunks_fts_content',
  'chunks_fts_data',
  'chunks_fts_docsize',
  'chunks_fts_idx',
  'nodes',
  'nodes_artifact',
  'nodes_parent',
  'schema_migrations',
  'supersessions',
  'table_columns',
  'tables',
  'tables_artifact',
];
