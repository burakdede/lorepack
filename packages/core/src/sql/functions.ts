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

/**
 * The remote backend's narrower list.
 *
 * D1 cannot be interrupted before its own 30 second limit, and one long query stalls every
 * other reader of that database. `json_each` and `json_tree` are table-valued: they turn one
 * cell into an unbounded row source, which locally the 5 second kill bounds and remotely
 * nothing does.
 */
export const REMOTE_QUERY_FUNCTIONS: ReadonlySet<string> = new Set(
  [...QUERY_FUNCTIONS].filter((name) => name !== 'json_each' && name !== 'json_tree'),
);

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
