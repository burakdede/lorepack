import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type BuildHandle,
  type BuildManifest,
  type BuildScope,
  buildManifestSchema,
  type CatalogArtifact,
  type CatalogArtifactSummary,
  type CatalogNode,
  type CatalogSearchCriteria,
  type CatalogSearchHit,
  type CatalogStore,
  type ColumnTypeName,
  LORE_DIRECTORY,
  LoreError,
  type RuntimeDeps,
  type StoredTableDescription,
  type TableQueryRequest,
  type TableQueryResult,
  type TableStore,
} from '@lorepack/core';
import {
  assertIdentifier,
  decodeValue,
  describeStoredTable,
  listTableRows,
  physicalTableNames,
  resolveTable,
  tableLocator,
} from './catalog/tables.js';
import { countRows, RUNTIME_TABLES, searchCatalog } from './catalog/writer.js';
import { loadMigrations } from './migrations.js';
import { buildMigrationsDirectory, stateMigrationsDirectory } from './migrations-path.js';
import { FileObjectStore } from './object-store.js';
import { executeQuery } from './sql/execute.js';
import { restrictToTables } from './sqlite.js';
import { LocalActiveBuildProvider, LocalStateStore } from './state-store.js';

/**
 * The local half of the runtime: ports over `node:sqlite` and the filesystem.
 *
 * It lives here rather than in `@lorepack/runtime` on purpose. The runtime is forbidden
 * from importing any backend, so the only thing that can know about SQLite is this file
 * and its Phase 6 counterpart over D1 and R2. That rule is machine-checked, which is what
 * makes "the same runtime runs in a Worker" a fact rather than an intention.
 */

class LocalCatalogStore implements CatalogStore {
  readonly #db: DatabaseSync;
  readonly #buildDirectory: string;

  constructor(db: DatabaseSync, buildDirectory: string) {
    this.#db = db;
    this.#buildDirectory = buildDirectory;
  }

  async manifest(): Promise<BuildManifest> {
    const path = join(this.#buildDirectory, 'manifest.json');
    if (!existsSync(path)) {
      throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This build has no manifest.', {
        remediation: 'The build directory is incomplete. Run `lore build` to create a new one.',
        subject: this.#buildDirectory,
      });
    }
    return buildManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  }

  async countChunks(): Promise<number> {
    return countRows(this.#db, 'chunks');
  }

  async countWarnings(): Promise<number> {
    return countRows(this.#db, 'build_warnings');
  }

  async artifacts(): Promise<readonly CatalogArtifactSummary[]> {
    // One statement for the whole listing rather than one per row: at the 2,500-file
    // envelope a per-artifact count query is 2,500 round trips to answer one question.
    const rows = this.#db
      .prepare(
        `SELECT a.id, a.relative_path AS relativePath, a.display_path AS displayPath, a.title,
                a.status, a.authority, a.media_type AS mediaType, a.object_hash AS objectHash,
                a.byte_size AS byteSize, a.parser_id AS parserId,
                (SELECT count(*) FROM chunks c WHERE c.artifact_id = a.id) AS chunkCount,
                (SELECT count(*) FROM nodes n WHERE n.artifact_id = a.id) AS nodeCount
           FROM artifacts a
          ORDER BY a.relative_path`,
      )
      .all() as Array<Record<string, string | number | null>>;

    return rows.map((row) => ({
      artifactId: String(row.id),
      relativePath: String(row.relativePath),
      displayPath: String(row.displayPath),
      title: row.title === null ? null : String(row.title),
      status: String(row.status) as CatalogArtifact['status'],
      authority: Number(row.authority),
      mediaType: String(row.mediaType),
      objectHash: String(row.objectHash),
      byteSize: Number(row.byteSize),
      parserId: String(row.parserId),
      chunkCount: Number(row.chunkCount),
      nodeCount: Number(row.nodeCount),
    }));
  }

  async artifact(idOrPath: string): Promise<CatalogArtifact | null> {
    // Two lookups, one statement, both parameterized: an artifact id and a canonical path
    // are the two things a caller can legitimately name, and neither reaches SQL as text.
    const row = this.#db
      .prepare(
        `SELECT id, relative_path AS relativePath, display_path AS displayPath, title,
                status, authority, media_type AS mediaType, object_hash AS objectHash
           FROM artifacts
          WHERE id = ? OR relative_path = ?
          LIMIT 1`,
      )
      .get(idOrPath, idOrPath) as Record<string, string | number | null> | undefined;
    if (row === undefined) return null;

    return {
      artifactId: String(row.id),
      relativePath: String(row.relativePath),
      displayPath: String(row.displayPath),
      title: row.title === null ? null : String(row.title),
      status: String(row.status) as CatalogArtifact['status'],
      authority: Number(row.authority),
      mediaType: String(row.mediaType),
      objectHash: String(row.objectHash),
    };
  }

  async nodes(artifactId: string): Promise<readonly CatalogNode[]> {
    const rows = this.#db
      .prepare(
        `SELECT id, artifact_id AS artifactId, kind, ordinal, title, text,
                heading_path AS headingPath, line_start AS lineStart, line_end AS lineEnd
           FROM nodes
          WHERE artifact_id = ?
          ORDER BY ordinal`,
      )
      .all(artifactId) as Array<Record<string, string | number | null>>;

    return rows.map((row) => ({
      nodeId: String(row.id),
      artifactId: String(row.artifactId),
      kind: String(row.kind),
      ordinal: Number(row.ordinal),
      title: row.title === null ? null : String(row.title),
      text: row.text === null ? '' : String(row.text),
      headingPath: JSON.parse(String(row.headingPath)) as string[],
      lineStart: row.lineStart === null ? null : Number(row.lineStart),
      lineEnd: row.lineEnd === null ? null : Number(row.lineEnd),
    }));
  }

  async supersededArtifacts(): Promise<ReadonlySet<string>> {
    const rows = this.#db
      .prepare('SELECT superseded_id AS supersededId FROM supersessions')
      .all() as Array<{ supersededId: string }>;
    return new Set(rows.map((row) => row.supersededId));
  }

  async search(
    query: string,
    criteria: CatalogSearchCriteria,
  ): Promise<readonly CatalogSearchHit[]> {
    const hits = searchCatalog(this.#db, query, {
      limit: criteria.limit,
      ...(criteria.match === undefined ? {} : { match: criteria.match }),
      ...(criteria.pathGlob === undefined ? {} : { pathGlob: criteria.pathGlob }),
      ...(criteria.extension === undefined ? {} : { extension: criteria.extension }),
      ...(criteria.statuses === undefined ? {} : { statuses: criteria.statuses }),
      ...(criteria.artifactId === undefined ? {} : { artifactId: criteria.artifactId }),
    });
    return hits.map((hit) => ({
      ...hit,
      status: hit.status as CatalogSearchHit['status'],
    }));
  }
}

/** Example rows in a `describeTable` response. A shape, not a preview of the data. */
const DESCRIBE_SAMPLE_ROWS = 5;

/**
 * Typed tables, read from the catalog written at build time.
 *
 * A build with no spreadsheet gets an empty list and a typed error, exactly as the
 * placeholder this replaced did. That symmetry is deliberate: "this build has no tables" and
 * "tables are not implemented" should never have been distinguishable to a caller, and now
 * only the first can be true.
 *
 * `query` reaches the engine only behind #77's statement validator, per-query authorizer and
 * deadline. It was refused outright until those existed, because shipping the catalog with an
 * unguarded `query` since the plumbing happened to be in place is how a read-only boundary
 * becomes a hole.
 */
class LocalTableStore implements TableStore {
  readonly #db: DatabaseSync;
  readonly #databasePath: string;

  constructor(db: DatabaseSync, databasePath: string) {
    this.#db = db;
    this.#databasePath = databasePath;
  }

  async list(): Promise<readonly { readonly tableId: string; readonly name: string }[]> {
    return listTableRows(this.#db);
  }

  async describe(tableId: string): Promise<StoredTableDescription | null> {
    return describeStoredTable(this.#db, tableId, DESCRIBE_SAMPLE_ROWS);
  }

  /**
   * A bounded read-only SELECT over one table.
   *
   * The query runs in a worker thread against its own read-only connection, whose authorizer
   * permits exactly this table's physical name and nothing else in the build. So a query
   * cannot reach another table, cannot read the catalog that would tell it those tables
   * exist, and cannot outlive its deadline. See `docs/architecture/adr-sql-surface.md`.
   */
  async query(request: TableQueryRequest): Promise<TableQueryResult> {
    const resolved = resolveTable(this.#db, request.tableId);
    if (resolved === null) {
      throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No table ${request.tableId} in this build.`, {
        remediation: 'Run `lore inspect tables` to see which tables this build contains.',
        subject: request.tableId,
      });
    }

    const outcome = await executeQuery({
      databasePath: this.#databasePath,
      // One table, per query. The allowlist is not the build's tables: it is this table,
      // which is what makes "cannot read another table" true rather than merely intended.
      allowedTables: [assertIdentifier(resolved.table.sql_name)],
      sql: request.sql,
      limit: request.limit,
    });

    // Column names and row keys are relabelled together. Relabelling only the rows would
    // return a `columns` list that does not name the keys of its own rows, which is the kind
    // of quiet inconsistency a caller only finds by index.
    const rename = (name: string): string =>
      resolved.columns.find((column) => column.sql_name === name)?.name ?? name;

    return {
      columns: outcome.columns.map(rename),
      // Relabelled to the source column names, so a caller reads `Postal Code` even though
      // the query addressed `c_2_postal_code`.
      rows: outcome.rows.map((row) => relabelRow(row, resolved.columns)),
      rowCount: outcome.rows.length,
      truncated: outcome.truncated,
      // Provenance is mandatory: a result without a locator is a bug, not a style issue. Built
      // by the same function `describeTable` uses, because building it twice is how the two
      // came to disagree about the sheet (#235).
      locator: tableLocator(resolved.table),
    } as TableQueryResult;
  }
}

/**
 * Generated column names back to the ones the source used, and stored values back to their
 * declared types.
 *
 * A query may alias, aggregate or compute, so a returned column often has no counterpart in
 * the catalog. Those keep whatever SQLite called them; only a plain physical column is
 * translated, because that is the only case where a better name exists.
 *
 * Decoding follows the same rule rather than a second one. A column this can rename is a
 * column whose declared type is known, which is exactly when reporting `true` instead of the
 * stored `1` is sound; an expression is renamed by neither and decoded by neither. One rule
 * degrades predictably, two would eventually disagree.
 */
function relabelRow(
  row: Record<string, unknown>,
  columns: readonly { name: string; sql_name: string; type: string }[],
): Record<string, unknown> {
  const bySqlName = new Map(columns.map((column) => [column.sql_name, column]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const column = bySqlName.get(key);
    out[column?.name ?? key] =
      column === undefined ? value : decodeValue(value, column.type as ColumnTypeName);
  }
  return out;
}

export interface LocalRuntimeOptions {
  readonly projectRoot: string;
  /** Establishes freshness. Omitted means every response reports `unknown`. */
  readonly freshness?: RuntimeDeps['freshness'];
}

export interface LocalRuntimeBackend extends RuntimeDeps {
  /** Releases every database this backend opened. The owner of the process calls it. */
  close(): void;
}

/**
 * Builds the ports for a project on disk.
 *
 * The caller owns the lifetime: `close()` releases the state database and every build
 * database the provider opened. A request never closes anything, which is what lets an
 * older build stay open until its last in-flight reader releases it.
 */
export function createLocalRuntimeBackend(options: LocalRuntimeOptions): LocalRuntimeBackend {
  const loreDirectory = join(options.projectRoot, LORE_DIRECTORY);
  const state = LocalStateStore.open(loreDirectory, stateMigrationsDirectory());
  const provider = new LocalActiveBuildProvider(state, join(loreDirectory, 'builds'));
  const objects = new FileObjectStore(join(loreDirectory, 'objects'));
  // Read once per backend rather than per request: the files on disk do not change while a
  // process runs, and this is the yardstick every build opened by it is measured against.
  const expectedMigration = latestMigrationId(loadMigrations(buildMigrationsDirectory()));
  // Connections whose schema has been checked. Keyed by the connection rather than by build
  // id, so a reopened build is checked again, and checked *before* the read-only authorizer
  // narrows that connection: `schema_migrations` is deliberately outside the runtime's read
  // surface, and widening that surface to accommodate a startup check would be the wrong
  // trade. A sealed build cannot change under an open connection, so once is enough.
  const schemaChecked = new WeakSet<DatabaseSync>();
  let closed = false;

  return {
    provider,
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
    open: async (handle: BuildHandle): Promise<BuildScope> => {
      const db = provider.database(handle);
      // Before `restrictToTables` below, which is what makes reading `schema_migrations`
      // possible at all without widening the read surface.
      if (!schemaChecked.has(db)) {
        assertBuildSchema(db, handle.buildId, expectedMigration);
        schemaChecked.add(db);
      }
      // Defence in depth, and not optional: the authorizer refuses every table outside the
      // read surface, so a defect in query construction cannot reach something it should
      // not. The list also permits `PRAGMA data_version`, which FTS5 reads internally and
      // which, denied, fails `MATCH` with "authorization denied" and no hint about why.
      // Widened with this build's own physical tables, which cannot be a static list:
      // their names are generated per build from the files it contains. Read from the
      // catalog and re-validated against the identifier pattern on the way out, so a
      // build database that arrived from somewhere else cannot name a table into the
      // allowlist. #77 narrows this again, per query, when user SQL becomes possible.
      restrictToTables(db, [...RUNTIME_TABLES, ...physicalTableNames(db)]);
      return {
        buildId: handle.buildId,
        // Operational state, held beside the build rather than inside it, because a sealed
        // build carries no wall-clock time.
        ...(createdAt(state, handle.buildId) === null
          ? {}
          : { createdAt: createdAt(state, handle.buildId) as string }),
        catalog: new LocalCatalogStore(db, join(loreDirectory, 'builds', handle.buildId)),
        tables: new LocalTableStore(
          db,
          join(loreDirectory, 'builds', handle.buildId, 'context.sqlite'),
        ),
        objects,
      };
    },
    // Idempotent: a process with a signal handler, an exit handler and an explicit
    // shutdown will call this more than once, and the second call must not be a crash.
    close: (): void => {
      if (closed) return;
      closed = true;
      provider.closeAll();
      state.close();
    },
  };
}

/** When the state store recorded this build, if it still knows. */
function createdAt(state: LocalStateStore, buildId: string): string | null {
  const summary = state.listBuilds().find((build) => build.buildId === buildId);
  return summary?.createdAt ?? null;
}

function latestMigrationId(migrations: readonly { id: string }[]): string {
  // Ids are fixed-width and zero-padded, so lexicographic order is numeric order.
  return migrations.reduce((highest, one) => (one.id > highest ? one.id : highest), '0000');
}

/**
 * Refuses a build written by an older Lorepack, at the boundary rather than inside SQLite.
 *
 * A sealed build is never migrated. Migrations run only against a writable database and a
 * build is opened read-only, so a build carries the schema it was written at forever. Without
 * this check the first symptom of reading an old build is whatever statement happens to name a
 * column that did not exist yet: `no such column: cell_range`, from inside a query, with no
 * indication that the cause is an old build or that rebuilding fixes it.
 *
 * Compared against the migration files this binary ships rather than against a hand-kept
 * number, so a future migration is covered by having been added, with nothing else to remember.
 *
 * Deliberately one-directional. A build *newer* than this binary is refused by the same
 * inequality, and should be: it may contain a table this code cannot read.
 */
function assertBuildSchema(db: DatabaseSync, buildId: string, expected: string): void {
  const row = db.prepare('SELECT max(id) AS latest FROM schema_migrations').get() as
    | { latest: string | null }
    | undefined;
  const actual = row?.latest ?? '0000';
  if (actual === expected) return;

  const older = actual < expected;
  throw new LoreError(
    'LORE_E_SCHEMA_MISMATCH',
    `Build ${buildId.slice(0, 17)} was written at catalog schema ${actual}, and this Lorepack reads ${expected}.`,
    {
      remediation: older
        ? 'Run `lore build` to compile this project again. A sealed build is never migrated in place, so an old one stays readable only by the version that wrote it.'
        : 'This build was written by a newer Lorepack than the one installed. Upgrade Lorepack, or rebuild the project with this version.',
      subject: buildId,
      details: { expected, actual },
    },
  );
}
