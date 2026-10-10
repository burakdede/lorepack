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
 *
 * One list for both layers (#563): the statement guard reads it for every `name(` call on
 * both profiles, and the local SQLite authorizer reads `ENGINE_FUNCTIONS`, which is this list
 * plus what SQLite calls on an operator's behalf. Keywords such as CAST and IN are not here:
 * they are syntax, not calls. The shared runtime contract calls every entry on every backend.
 */
export const QUERY_FUNCTIONS: ReadonlySet<string> = new Set([
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
  'likely',
  'unlikely',
  // Dates, over values in the row. The guard refuses every form that reads the clock or the
  // time zone (`DATE_FUNCTIONS` below).
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
]);

/**
 * Table-valued functions, allowed as a row source on the local profile only.
 *
 * They turn one cell into an unbounded row source, which locally the 5 second kill bounds and
 * remotely nothing does: D1 cannot be interrupted before its own 30 second limit. SQLite
 * authorizes them as a read of a virtual table named after the function, not as a call.
 */
export const ROW_FUNCTIONS: ReadonlySet<string> = new Set(['json_each', 'json_tree']);

/**
 * What the local authorizer permits as `SQLITE_FUNCTION`: the allowlist, plus the functions
 * SQLite calls for the `->` and `->>` operators, which the guard admits as operators.
 */
export const ENGINE_FUNCTIONS: ReadonlySet<string> = new Set([...QUERY_FUNCTIONS, '->', '->>']);

/**
 * Date and time functions. Each reads the clock when given `'now'` or no time value at all,
 * and the time zone when given `'localtime'` or `'utc'`, so the guard refuses those forms
 * (#452). An answer that depends on when or where it ran cannot be cited.
 */
export const DATE_FUNCTIONS: ReadonlySet<string> = new Set([
  'date',
  'time',
  'datetime',
  'julianday',
  'unixepoch',
  'strftime',
  'timediff',
]);

/** Keywords SQLite evaluates to the current time. */
export const CLOCK_KEYWORDS: ReadonlySet<string> = new Set([
  'current_date',
  'current_time',
  'current_timestamp',
]);

/** Aggregates, which a window turns into an O(rows x frame) computation. */
export const AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set([
  'count',
  'sum',
  'total',
  'avg',
  'min',
  'max',
  'group_concat',
  'string_agg',
]);
