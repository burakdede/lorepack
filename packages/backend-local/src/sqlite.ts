import { constants, DatabaseSync } from 'node:sqlite';
import { LoreError } from '@lorepack/core';

/**
 * The only module in the repository that imports node:sqlite. The API is a release
 * candidate in the supported Node range, so confining it here means an upstream change
 * has one blast radius rather than many.
 *
 * Minimum versions for the members used below, all at or under our 24.15 floor:
 *   setAuthorizer     24.10.0
 *   defensive default 24.14.0
 *   db.limits         24.15.0
 */

/**
 * Members of the node:sqlite API that Lorepack depends on but that @types/node has not
 * caught up with. The published types for Node 24 stop at 24.13.3, while `defensive`
 * landed in 24.14 and `limits` in 24.15. Rather than assume they exist, the shape is
 * declared here and verified at runtime by `assertSqliteApiSurface`.
 */
interface SqliteRuntimeApi {
  readonly limits: Record<string, number>;
  setAuthorizer(handler: (actionCode: number, arg1: string | null) => number): void;
  enableDefensive(active: boolean): void;
}

function api(db: DatabaseSync): SqliteRuntimeApi {
  return db as unknown as SqliteRuntimeApi;
}

/**
 * Confirms the release-candidate API surface this adapter relies on is actually present.
 * The engine guard checks the version string; this checks the capability, which is what
 * actually matters if a future patch release moves something.
 */
export function assertSqliteApiSurface(db: DatabaseSync): void {
  const missing: string[] = [];
  const surface = api(db);
  if (typeof surface.setAuthorizer !== 'function') missing.push('setAuthorizer (Node 24.10+)');
  if (typeof surface.enableDefensive !== 'function') missing.push('enableDefensive (Node 24.14+)');
  if (typeof surface.limits !== 'object' || surface.limits === null) {
    missing.push('limits (Node 24.15+)');
  }
  if (missing.length === 0) return;
  throw new LoreError(
    'LORE_E_SQLITE_UNAVAILABLE',
    `This Node build's node:sqlite is missing: ${missing.join(', ')}.`,
    {
      remediation: 'Install Node 24.15 or newer from https://nodejs.org/en/download',
      details: { nodeVersion: process.versions.node, execPath: process.execPath },
    },
  );
}

export interface OpenOptions {
  /** Bounded SQLite runtime limits. Architecture section 19.5. */
  readonly limits?: Partial<SqliteLimits>;
}

export interface SqliteLimits {
  length: number;
  sqlLength: number;
  column: number;
  exprDepth: number;
  compoundSelect: number;
  vdbeOp: number;
  functionArg: number;
  attach: number;
  likePatternLength: number;
  variableNumber: number;
  triggerDepth: number;
}

/** Conservative ceilings for any database that will execute user-authored SQL. */
export const SAFE_QUERY_LIMITS: SqliteLimits = {
  length: 1_000_000,
  sqlLength: 100_000,
  column: 200,
  exprDepth: 100,
  compoundSelect: 10,
  vdbeOp: 250_000,
  functionArg: 32,
  attach: 0,
  likePatternLength: 1_000,
  variableNumber: 100,
  triggerDepth: 4,
};

function applyLimits(db: DatabaseSync, limits: Partial<SqliteLimits>): void {
  const surface = api(db);
  for (const [name, value] of Object.entries(limits)) {
    surface.limits[name] = value;
    // Read back: SQLite clamps to its compile-time maximum rather than failing, so a
    // limit that did not take effect must not be mistaken for one that did.
    const effective = surface.limits[name] ?? Number.POSITIVE_INFINITY;
    if (effective > value) {
      throw new LoreError(
        'LORE_E_SQLITE_UNAVAILABLE',
        `SQLite refused the ${name} limit: asked for ${value}, got ${effective}.`,
        { remediation: 'Report this with your Node and SQLite versions.' },
      );
    }
  }
}

/**
 * Opens a sealed build read-only. Extensions are disabled, the defensive flag is on, and
 * runtime limits are bounded before any statement is prepared.
 */
export function openReadOnly(path: string, options: OpenOptions = {}): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, {
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
  } catch (cause) {
    throw new LoreError('LORE_E_SQLITE_UNAVAILABLE', `Cannot open ${path} for reading.`, {
      remediation: 'Check the build exists and is readable. Run `lore doctor`.',
      cause,
    });
  }
  assertSqliteApiSurface(db);
  // Defensive mode is the default from Node 24.14, but stating it means a future default
  // change cannot silently weaken a read-only build handle.
  api(db).enableDefensive(true);
  db.exec('PRAGMA busy_timeout = 5000');
  applyLimits(db, options.limits ?? SAFE_QUERY_LIMITS);
  return db;
}

/** Opens a candidate build for writing. Only the compiler does this, never the runtime. */
export function openWritable(path: string): DatabaseSync {
  try {
    const db = new DatabaseSync(path, {
      readOnly: false,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
    });
    assertSqliteApiSurface(db);
    api(db).enableDefensive(true);
    // Deliberately not WAL. A WAL database leaves `-wal` and `-shm` beside it, and a
    // read-only connection creates them without being able to clean them up, which would
    // make `lore status` write to disk and a sealed build three files instead of one.
    // Writers are already serialized by the project lock, so WAL's concurrency buys
    // nothing here; `busy_timeout` covers the reader that arrives mid-write.
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  } catch (cause) {
    throw new LoreError('LORE_E_SQLITE_UNAVAILABLE', `Cannot open ${path} for writing.`, {
      remediation: 'Check the directory exists and is writable.',
      cause,
    });
  }
}

/**
 * Denies everything except reads from an allowlist of tables, at the engine boundary.
 * Defence in depth: even if a SQL validator were bypassed, this still refuses.
 */
export function restrictToTables(db: DatabaseSync, allowedTables: readonly string[]): void {
  const allowed = new Set(allowedTables);
  api(db).setAuthorizer((actionCode: number, arg1: string | null) => {
    switch (actionCode) {
      case constants.SQLITE_SELECT:
      case constants.SQLITE_FUNCTION:
        return constants.SQLITE_OK;
      case constants.SQLITE_PRAGMA:
        // FTS5 reads `data_version` internally to notice that the table changed under it,
        // so denying it would make MATCH fail outright. It exposes a change counter and
        // nothing else, and no other pragma is permitted.
        return arg1 === 'data_version' ? constants.SQLITE_OK : constants.SQLITE_DENY;
      case constants.SQLITE_READ:
        return arg1 !== null && allowed.has(arg1) ? constants.SQLITE_OK : constants.SQLITE_DENY;
      default:
        return constants.SQLITE_DENY;
    }
  });
}

export function integrityCheck(db: DatabaseSync): { ok: boolean; problems: string[] } {
  const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: string }>;
  const problems = rows
    .map((row) => row.integrity_check ?? '')
    .filter((value) => value !== '' && value !== 'ok');
  return { ok: problems.length === 0, problems };
}

export function sqliteVersion(db: DatabaseSync): string {
  const row = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
  return row.version;
}
