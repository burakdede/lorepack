import { constants, type DatabaseSync } from 'node:sqlite';
import { bound, ENGINE_FUNCTIONS, ROW_FUNCTIONS } from '@lorepack/core';
import { openReadOnly } from '../sqlite.js';

/**
 * The child process that actually runs a model-authored query.
 *
 * A **process**, not a worker thread, and that was decided by measurement. Two things are
 * true and together they leave no alternative:
 *
 * 1. `db.limits.vdbeOp = 250_000` does not stop a runaway query. A recursive CTE with no
 *    termination condition was still running after sixty seconds.
 * 2. `worker.terminate()` does not return while the thread sits inside a synchronous native
 *    SQLite call. Measured: a terminate request on such a thread had still not resolved
 *    twenty seconds later. V8 cannot interrupt native code, so the thread is unkillable for
 *    as long as the query runs.
 *
 * A process can always be killed, because the kill comes from the operating system rather
 * than from the runtime. That is the only thing that turns section 19.5's deadline from an
 * intention into a guarantee. `adr-sql-surface.md` records both measurements.
 *
 * It opens its own read-only handle rather than receiving one: a handle cannot cross a
 * process boundary, and a fresh connection guarantees the authorizer installed here is the
 * only one in force.
 */

interface Request {
  readonly sql: string;
  readonly limit: number;
  readonly maxBytes: number;
}

interface Setup {
  readonly databasePath: string;
  /** The physical tables this query may read. Nothing else in the build is visible. */
  readonly allowedTables: readonly string[];
}

const send = process.send?.bind(process);
if (send === undefined) throw new Error('The query engine must be started with an IPC channel.');

let allowed = new Set<string>();
let db: DatabaseSync | null = null;

/**
 * Deny by default, at the engine boundary.
 *
 * This is the control, not the validator in front of it. #77 requires the security tests to
 * pass with statement validation disabled, and this is what makes that true: every write, every
 * DDL action, every `ATTACH`, every pragma and every table outside the allowlist is refused
 * here, where no amount of clever text can reach.
 *
 * The allowlist is **per query**: it holds the physical tables of the table being queried and
 * nothing else, so a query cannot read another table in the same build, and cannot read the
 * catalog that would tell it those tables exist.
 */
function install(setup: Setup): DatabaseSync {
  allowed = new Set(setup.allowedTables);
  const opened = openReadOnly(setup.databasePath);
  opened.setAuthorizer(
    (action: number, arg1: string | null, arg2: string | null, database: string | null) => {
      switch (action) {
        case constants.SQLITE_SELECT:
          return constants.SQLITE_OK;
        case constants.SQLITE_READ:
          // `database` is the discriminator, and it is the whole reason common table expressions
          // work here. Reading a real table reports `main`; reading the result of a CTE reports
          // null, because there is no database behind it. Verified against a recursive CTE, which
          // issues `SQLITE_READ` for its own name with a null database.
          //
          // Allowing the null case is safe rather than a hole: whatever a CTE is built from was
          // itself authorized, with `main`, before this. Denying it instead made every `WITH`
          // query fail, including the ones the statement validator deliberately accepts.
          if (database === null) return constants.SQLITE_OK;
          if (arg1 === null) return constants.SQLITE_DENY;
          // A table-valued JSON function is read as a virtual table named after it. It reads
          // only its arguments, and anything those name is authorized on its own (#563).
          return allowed.has(arg1) || ROW_FUNCTIONS.has(arg1)
            ? constants.SQLITE_OK
            : constants.SQLITE_DENY;
        case constants.SQLITE_FUNCTION: {
          // arg2 carries the function name for this action code; arg1 is null.
          const name = (arg2 ?? arg1 ?? '').toLowerCase();
          return ENGINE_FUNCTIONS.has(name) ? constants.SQLITE_OK : constants.SQLITE_DENY;
        }
        case constants.SQLITE_RECURSIVE:
          // Allowed, and bounded by the deadline rather than by refusal: a recursive CTE is a
          // legitimate and useful thing to write over a table of parts or accounts. The runaway
          // case is what the worker exists for.
          return constants.SQLITE_OK;
        default:
          return constants.SQLITE_DENY;
      }
    },
  );
  return opened;
}

process.on('message', (message: Setup | Request) => {
  if ('databasePath' in message) {
    try {
      db = install(message);
      send({ ready: true });
    } catch (cause) {
      send({ ok: false, kind: 'failed', message: (cause as Error).message });
    }
    return;
  }

  const request = message;
  try {
    if (db === null) throw new Error('The query engine was not configured.');
    const statement = db.prepare(bound(request.sql, request.limit));

    // One row at a time, with a running count of the bytes the response would carry, so the
    // size cap stops the query at the first row past it. Materialising every row first and
    // measuring afterwards let one query reach 4 GB before the 1 MB cap fired (#559).
    //
    // Serialized size is checked here rather than by the caller, because the caller would
    // have to receive the rows to measure them, and receiving them is the cost being bounded.
    const kept: Record<string, unknown>[] = [];
    let truncated = false;
    let serializedBytes = 2;
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
      if (kept.length === request.limit) {
        truncated = true;
        break;
      }
      serializedBytes += Buffer.byteLength(JSON.stringify(row)) + (kept.length === 0 ? 0 : 1);
      if (serializedBytes > request.maxBytes) {
        send({ ok: false, kind: 'too-large', bytes: serializedBytes, peakRssBytes: peakRss() });
        return;
      }
      kept.push(row);
    }

    send({
      ok: true,
      columns: kept[0] === undefined ? columnsOf(statement) : Object.keys(kept[0]),
      rows: kept,
      truncated,
    });
  } catch (cause) {
    // Passed through as text and classified by the parent. Nothing about the filesystem
    // crosses this boundary, because this process never puts a path in a message.
    send({ ok: false, kind: 'failed', message: (cause as Error).message });
  }
});

/** The most memory this process has held, so the parent can report what a refusal cost. */
function peakRss(): number {
  return process.resourceUsage().maxRSS * 1024;
}

/** Column names for an empty result, which `Object.keys` of a missing row cannot give. */
function columnsOf(statement: ReturnType<DatabaseSync['prepare']>): string[] {
  try {
    return (statement.columns() as { name: string }[]).map((column) => column.name);
  } catch {
    return [];
  }
}
