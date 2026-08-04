import { constants, type DatabaseSync } from 'node:sqlite';
import { openReadOnly } from '../sqlite.js';
import { bound } from './statement.js';

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

/**
 * Functions a query may call.
 *
 * An allowlist rather than a denylist, because the interesting SQLite functions are the ones
 * nobody remembers to deny. `load_extension` is the obvious one and is already impossible
 * (`allowExtension: false`), but the general rule is what protects against the next one.
 *
 * This is deliberately generous about arithmetic, text and aggregation, which is what a person
 * querying a spreadsheet actually needs, and silent about anything touching the filesystem, the
 * clock or the database's own structure. A non-deterministic function such as `random()` is
 * excluded for a further reason: a query that returns different rows on each run cannot be
 * cited, and every result here carries provenance.
 */
const ALLOWED_FUNCTIONS = new Set([
  // Aggregates
  'count',
  'sum',
  'total',
  'avg',
  'min',
  'max',
  'group_concat',
  'string_agg',
  // Text
  'length',
  'lower',
  'upper',
  'substr',
  'substring',
  'trim',
  'ltrim',
  'rtrim',
  'replace',
  'instr',
  'printf',
  'format',
  'concat',
  'concat_ws',
  'char',
  'unicode',
  'hex',
  'quote',
  // Numeric
  'abs',
  'round',
  'ceil',
  'ceiling',
  'floor',
  'sign',
  'sqrt',
  'pow',
  'power',
  'exp',
  'ln',
  'log',
  'log2',
  'log10',
  'mod',
  'trunc',
  'acos',
  'asin',
  'atan',
  'atan2',
  'cos',
  'sin',
  'tan',
  'degrees',
  'radians',
  'pi',
  // Null handling and typing
  'coalesce',
  'ifnull',
  'nullif',
  'iif',
  'typeof',
  'cast',
  'likely',
  'unlikely',
  // Dates, over values in the row. `now` is refused below.
  'date',
  'time',
  'datetime',
  'julianday',
  'unixepoch',
  'strftime',
  'timediff',
  // JSON, which spreadsheet-derived text often holds
  'json',
  'json_array',
  'json_array_length',
  'json_extract',
  'json_object',
  'json_type',
  'json_valid',
  'json_quote',
  'json_each',
  'json_tree',
  // Window functions
  'row_number',
  'rank',
  'dense_rank',
  'percent_rank',
  'cume_dist',
  'ntile',
  'lag',
  'lead',
  'first_value',
  'last_value',
  'nth_value',
  // Comparison helpers SQLite implements as functions
  'like',
  'glob',
  'nvl',
  'in',
]);

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
          return arg1 !== null && allowed.has(arg1) ? constants.SQLITE_OK : constants.SQLITE_DENY;
        case constants.SQLITE_FUNCTION: {
          // arg2 carries the function name for this action code; arg1 is null.
          const name = (arg2 ?? arg1 ?? '').toLowerCase();
          return ALLOWED_FUNCTIONS.has(name) ? constants.SQLITE_OK : constants.SQLITE_DENY;
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
    const rows = statement.all() as Record<string, unknown>[];

    const truncated = rows.length > request.limit;
    const kept = truncated ? rows.slice(0, request.limit) : rows;

    // Serialized size is checked here rather than by the caller, because the caller would
    // have to receive the rows to measure them, and receiving them is the cost being bounded.
    const serialized = JSON.stringify(kept);
    if (serialized.length > request.maxBytes) {
      send({ ok: false, kind: 'too-large', bytes: serialized.length });
      return;
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

/** Column names for an empty result, which `Object.keys` of a missing row cannot give. */
function columnsOf(statement: ReturnType<DatabaseSync['prepare']>): string[] {
  try {
    return (statement.columns() as { name: string }[]).map((column) => column.name);
  } catch {
    return [];
  }
}
