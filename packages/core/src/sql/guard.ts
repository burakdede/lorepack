import { AGGREGATE_FUNCTIONS, QUERY_FUNCTIONS, REMOTE_QUERY_FUNCTIONS } from './functions.js';
import { lexSql, refuseQuery, type Token } from './lexer.js';
import { validateStatement } from './statement.js';

/**
 * One table, and nothing else, before a statement reaches any database (#406).
 *
 * A model-facing table query may read the one physical table its `tableId` resolved to. The
 * local backend also enforces that at the engine with a SQLite authorizer, but the authorizer
 * is consulted for column reads, not for opening a table, so on its own it lets a query learn
 * that another table exists and how many rows it has. D1 has no authorizer at all. This guard
 * is therefore the control on the remote backend and a second layer on the local one, and it
 * is the same code on both.
 *
 * It fails closed, and it is not a SQL parser (`docs/architecture/adr-sql-surface.md`). In a
 * SELECT, SQLite resolves a table only where a row source is expected: after FROM, after any
 * JOIN, after a comma inside a FROM clause, and after IN without a parenthesis. Every other
 * name is a column, an alias, a function or a keyword. So the guard tracks exactly those
 * positions, and refuses anything that could reach another object some other way:
 *
 * 1. **Shape.** One statement beginning with SELECT, WITH or VALUES; no parameters; no
 *    non-ASCII outside string literals; nothing unterminated; bounded size, length and depth;
 *    balanced parentheses.
 * 2. **Names.** No token of any kind spells another object in the database or a reserved
 *    family (`sqlite_*`, `pragma_*`, `_cf_*`, `dbstat`, `main`, `temp`). A string literal
 *    counts, because SQLite accepts `FROM 'name'`.
 * 3. **Row sources**, the primary control. Where a row source is expected, only the allowed
 *    table, a common table expression this statement declared, or a parenthesis may appear:
 *    no string, quoted name, schema qualifier, or table-valued function the profile does not
 *    allow.
 * 4. **Calls and qualifiers.** A word called as a function must be a keyword or an allowed
 *    function; a name used as a qualifier (`x.`) must be the table or a declared alias.
 * 5. **Cost** (remote only). D1 cannot be interrupted before its 30 second limit, so recursive
 *    common table expressions (with or without the keyword), aggregates used as windows, and
 *    statements whose estimated row product exceeds a bound are refused there. Locally the 5
 *    second kill bounds them. The estimate charges the table its row count, a VALUES list or a
 *    SELECT without FROM the rows it spells out, and a subquery or common table expression its
 *    own estimate (`estimate` below). It bounds rows, not the work done per row: see
 *    `docs/architecture/security.md` for what remains and the Worker's rate limit.
 * 6. **Format widths** (both profiles). `printf` and `format` take a literal format whose widths
 *    and precisions are small literals, because `%.*c` makes one row cost what a million rows
 *    would and no row bound sees it.
 *
 * Every refusal is the same `LORE_E_SQL_REJECTED` message, so the reason for a refusal cannot
 * be used to learn which names exist.
 *
 * Returns the statement with every comment replaced by a space. A comment is whitespace to
 * SQLite, and removing it means nothing can swallow the wrapper that bounds the result.
 */

export type QueryProfile = 'local' | 'remote';

export interface SingleTableQuery {
  /** The physical table the request resolved to. */
  readonly table: string;
  /** Every object name in the database the caller knows of. */
  readonly schemaNames: readonly string[];
  readonly profile: QueryProfile;
  /** The table's row count, for the remote join bound. */
  readonly rowCount?: number;
}

export const QUERY_GUARD_LIMITS = {
  maxBytes: 8_192,
  maxTokens: 2_000,
  maxDepth: 32,
  /** The largest row product one statement may form remotely. */
  maxJoinRows: 5_000_000,
  /** The largest width or precision a `printf` or `format` conversion may ask for. */
  maxFormatWidth: 100,
} as const;

/**
 * Words SQLite reads as keywords in a SELECT.
 *
 * Two uses only: a keyword may stand before `(`, and a keyword directly after a row source is
 * not an alias. Neither decides what a statement can read, so a missing keyword can only
 * refuse a valid query, never admit an unsafe one.
 */
const KEYWORDS = new Set([
  'select',
  'from',
  'where',
  'group',
  'by',
  'having',
  'order',
  'limit',
  'offset',
  'as',
  'and',
  'or',
  'not',
  'in',
  'is',
  'isnull',
  'notnull',
  'null',
  'like',
  'glob',
  'regexp',
  'match',
  'between',
  'case',
  'when',
  'then',
  'else',
  'end',
  'distinct',
  'all',
  'asc',
  'desc',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'outer',
  'cross',
  'natural',
  'on',
  'using',
  'union',
  'intersect',
  'except',
  'with',
  'recursive',
  'materialized',
  'values',
  'cast',
  'collate',
  'escape',
  'exists',
  'over',
  'partition',
  'rows',
  'range',
  'groups',
  'preceding',
  'following',
  'unbounded',
  'current',
  'row',
  'filter',
  'window',
  'nulls',
  'first',
  'last',
  'exclude',
  'ties',
  'others',
  'no',
  'indexed',
]);

/**
 * Keywords that end a FROM clause at their own depth. WINDOW is not here: it ends the clause only
 * when it opens a definition, which `opensWindow` decides; otherwise it is an alias.
 */
const FROM_ENDERS = new Set([
  'where',
  'group',
  'having',
  'order',
  'limit',
  'union',
  'intersect',
  'except',
]);

/**
 * The words that may follow a row source without being its alias. Anything else directly after
 * a row source is an alias, which is how SQLite reads it too: `FROM t window` declares an alias
 * named `window`, and treating it as a WINDOW clause would stop checking the row sources after
 * it.
 */
const FOLLOWS_SOURCE = new Set([
  'where',
  'group',
  'having',
  'order',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'outer',
  'cross',
  'natural',
  'on',
  'using',
  'indexed',
  'not',
  'as',
]);

const RESERVED_NAMES = new Set(['dbstat', 'main', 'temp', 'temporary']);

/** A remote physical table (`<prefix>_<16 hex>`) or a local one (`t_<slug>_<12 hex>`). */
const PHYSICAL_SHAPE = /(_[0-9a-f]{16}$)|(^t_(?:[a-z0-9_]*_)?[0-9a-f]{12}$)/;

const STATEMENT_START = new Set(['select', 'with', 'values']);

type Closes = 'source' | 'cteColumns' | 'cteBody' | 'windowBody' | null;

interface Frame {
  /** Inside a FROM clause at this depth. */
  from: boolean;
  /** The next token must be a row source. */
  expectSource: boolean;
  /** The previous token ended a row source, so an alias may follow. */
  afterSource: boolean;
  /**
   * Common table expressions declared at this depth, which SQLite scopes to it, with the rows
   * each is estimated to produce. `null` while its own body is being read: a reference then
   * makes it recursive.
   */
  ctes: Map<string, number | null>;
  /** The CTE whose body the next `cteBody` frame holds. */
  pendingCte: string | null;
  /** The row estimate of the SELECT core being read: the product of its sources. */
  core: number;
  /** The summed estimates of the cores before it in a compound SELECT. */
  compound: number;
  /** In a VALUES list: the rows it has listed so far. */
  values: number | null;
  /** In a WITH list: expecting a name, after a name, or after a body. */
  withState: 'name' | 'afterName' | 'afterBody' | null;
  /** In a WINDOW clause: expecting a name, after a name, or after a body. */
  windowState: 'name' | 'afterName' | 'afterBody' | null;
  /** Every name in this frame is being declared (a CTE's column list). */
  declaring: boolean;
  /** What the enclosing frame learns when this one closes. */
  closes: Closes;
}

function frame(overrides: Partial<Frame> = {}): Frame {
  return {
    from: false,
    expectSource: false,
    afterSource: false,
    ctes: new Map(),
    pendingCte: null,
    core: 1,
    compound: 0,
    values: null,
    withState: null,
    windowState: null,
    declaring: false,
    closes: null,
    ...overrides,
  };
}

type NameToken = Token & { readonly kind: 'word' | 'quoted' };

const isName = (token: Token | undefined): token is NameToken =>
  token !== undefined && (token.kind === 'word' || token.kind === 'quoted');

export function guardSingleTableQuery(sql: string, query: SingleTableQuery): string {
  if (new TextEncoder().encode(sql).byteLength > QUERY_GUARD_LIMITS.maxBytes) throw refuseQuery();

  // Rule 1. Comments become spaces before anything else reads the statement, including the
  // shape check and the wrapper, so a comment can neither hide a separator nor swallow the
  // `) LIMIT n` that bounds the result.
  const tokens = lexSql(sql);
  const stripped = tokens.map((token) => (token.kind === 'comment' ? ' ' : token.text)).join('');
  // The existing shape check: one statement, beginning as a read. Its messages describe a typo
  // or a write in the caller's own terms and say nothing about the database.
  const statement = validateStatement(stripped);

  const significant = tokens.filter((token) => token.kind !== 'space' && token.kind !== 'comment');
  const body = significant.at(-1)?.text === ';' ? significant.slice(0, -1) : significant;
  if (body.length > QUERY_GUARD_LIMITS.maxTokens) throw refuseQuery();
  assertBalanced(body);

  const table = query.table.toLowerCase();
  const others = new Set(
    query.schemaNames.map((name) => name.toLowerCase()).filter((name) => name !== table),
  );
  const forbidden = (value: string): boolean =>
    // No exemption for column names: a column spelled like another object is refused rather
    // than trusted, because the guard cannot tell which of the two a given token means.
    value !== table &&
    (others.has(value) ||
      RESERVED_NAMES.has(value) ||
      value.startsWith('sqlite_') ||
      value.startsWith('pragma_') ||
      value.startsWith('_cf_') ||
      PHYSICAL_SHAPE.test(value));

  // Rule 2.
  for (const token of body) {
    if (
      token.kind !== 'operator' &&
      token.kind !== 'number' &&
      token.kind !== 'blob' &&
      forbidden(token.value)
    ) {
      throw refuseQuery();
    }
  }

  const functions = query.profile === 'remote' ? REMOTE_QUERY_FUNCTIONS : QUERY_FUNCTIONS;
  const rowFunctions = query.profile === 'local' ? new Set(['json_each', 'json_tree']) : new Set();
  const declared = new Set<string>();
  const declarations = new Set<number>();

  // Rule 3.
  const stack: Frame[] = [frame()];
  const top = (): Frame => stack[stack.length - 1] as Frame;
  const open = (closes: Closes, overrides: Partial<Frame> = {}): void => {
    if (stack.length > QUERY_GUARD_LIMITS.maxDepth) throw refuseQuery();
    stack.push(frame({ closes, ...overrides }));
  };
  const cteLevel = (name: string): Frame | undefined =>
    [...stack].reverse().find((level) => level.ctes.has(name));
  // Every row source, and every nested query, multiplies the estimate of the query around it,
  // at every depth. Per-clause counts would let nested subqueries multiply each other unseen,
  // and D1 cannot stop a query early. A subquery in an expression is charged as though it ran
  // once per row, because the guard cannot tell whether it is correlated.
  const remote = query.profile === 'remote';
  const charge = (current: Frame, rows: number): void => {
    current.core *= rows;
    if (remote && current.core > QUERY_GUARD_LIMITS.maxJoinRows) throw refuseQuery();
  };
  const countSource = (current: Frame, rows: number): void => {
    current.afterSource = true;
    charge(current, rows);
  };
  // A VALUES list ends where its core does: at a compound operator, ORDER BY, LIMIT, or the
  // end of its query.
  const endValues = (current: Frame): void => {
    if (current.values === null) return;
    const rows = current.values;
    current.values = null;
    charge(current, rows);
  };
  const estimate = (closed: Frame): number => {
    endValues(closed);
    const rows = closed.compound + closed.core;
    if (remote && rows > QUERY_GUARD_LIMITS.maxJoinRows) throw refuseQuery();
    return rows;
  };
  const tableRows = Math.max(query.rowCount ?? 0, 1);
  // WINDOW opens a clause only when a definition follows; otherwise it is a plain name.
  const opensWindow = (index: number): boolean =>
    isName(body[index + 1]) && body[index + 2]?.value === 'as';

  for (let index = 0; index < body.length; index += 1) {
    const token = body[index] as Token;
    const next = body[index + 1];
    const current = top();
    const word = token.kind === 'word' ? token.value : null;

    if (current.expectSource) {
      current.expectSource = false;
      if (token.text === '(') {
        const statementInside = next?.kind === 'word' && STATEMENT_START.has(next.value);
        open('source', { from: !statementInside, expectSource: !statementInside });
        continue;
      }
      // Only a bare word names a row source: never a string, a quoted name, or `schema.name`.
      if (word === null || next?.text === '.') throw refuseQuery();
      if (next?.text === '(') {
        if (!rowFunctions.has(word)) throw refuseQuery();
        index += 1;
        open('source');
        continue;
      }
      if (word === table) {
        countSource(current, tableRows);
        continue;
      }
      const level = cteLevel(word);
      if (level === undefined) throw refuseQuery();
      const rows = level.ctes.get(word) ?? null;
      // A CTE named inside its own body is recursive to SQLite, keyword or not.
      if (rows === null && remote) throw refuseQuery();
      countSource(current, rows ?? 1);
      continue;
    }

    if (current.afterSource) {
      current.afterSource = false;
      if (word === 'as' && isName(next)) {
        declared.add(next.value);
        index += 1;
        continue;
      }
      const definesWindow = word === 'window' && opensWindow(index);
      if (
        token.kind === 'quoted' ||
        (word !== null && !FOLLOWS_SOURCE.has(word) && !definesWindow)
      ) {
        declared.add(token.value);
        continue;
      }
    }

    if (current.declaring) {
      // A column list holds names and commas, nothing else. Anything more would be read
      // without the row-source rule, so it is refused rather than skipped.
      if (isName(token)) {
        declared.add(token.value);
        continue;
      }
      if (token.text === ',') continue;
      if (token.text !== ')') throw refuseQuery();
    }

    if (current.withState === 'name' && isName(token)) {
      if (word === 'recursive') {
        if (query.profile === 'remote') throw refuseQuery();
        continue;
      }
      // A CTE named like the table shadows it, so every later reference would be charged as
      // the table while reading whatever the CTE produces, recursion included.
      if (token.value === table) throw refuseQuery();
      current.ctes.set(token.value, null);
      current.pendingCte = token.value;
      declared.add(token.value);
      // A CTE name may be followed by its column list, which is not a call.
      declarations.add(index);
      current.withState = 'afterName';
      continue;
    }

    if (current.windowState === 'name' && isName(token)) {
      declared.add(token.value);
      current.windowState = 'afterName';
      continue;
    }

    if (token.text === '(') {
      const previous = body[index - 1]?.value;
      if (current.withState === 'afterName') {
        if (previous === 'as' || previous === 'materialized') open('cteBody');
        else open('cteColumns', { declaring: true });
      } else if (current.windowState === 'afterName') {
        open('windowBody');
      } else {
        open(null);
      }
      continue;
    }

    if (token.text === ')') {
      const closed = stack.pop() as Frame;
      const parent = top();
      const rows = estimate(closed);
      if (closed.closes === 'source') {
        countSource(parent, rows);
      } else if (closed.closes === 'cteBody') {
        // Charged where it is read, once per reference, not where it is declared.
        if (parent.pendingCte !== null) parent.ctes.set(parent.pendingCte, rows);
        parent.pendingCte = null;
        parent.withState = 'afterBody';
      } else {
        if (closed.closes === 'windowBody') parent.windowState = 'afterBody';
        charge(parent, rows);
      }
      continue;
    }

    if (token.text === ',') {
      if (current.withState === 'afterBody') current.withState = 'name';
      else if (current.windowState === 'afterBody') current.windowState = 'name';
      else if (current.from) current.expectSource = true;
      else if (current.values !== null) current.values += 1;
      continue;
    }

    if (word === null) continue;
    if (current.withState === 'afterBody') current.withState = null;
    if (current.windowState === 'afterBody') current.windowState = null;

    if (word === 'with') {
      current.withState = 'name';
    } else if (word === 'from' && isDistinctOperator(body, index)) {
      // `a IS [NOT] DISTINCT FROM b` is a comparison, not a FROM clause.
    } else if (word === 'from') {
      current.from = true;
      current.expectSource = true;
    } else if (word === 'join') {
      current.expectSource = true;
    } else if (word === 'window' && opensWindow(index)) {
      current.from = false;
      current.windowState = 'name';
    } else if (word === 'values') {
      current.values ??= 1;
    } else if (FROM_ENDERS.has(word)) {
      current.from = false;
      endValues(current);
      if (word === 'union' || word === 'intersect' || word === 'except') {
        current.compound += current.core;
        current.core = 1;
      }
    } else if (word === 'in' && next?.text !== '(') {
      // `x IN name` reads a table, exactly as FROM does.
      current.expectSource = true;
    } else if (
      word === 'as' &&
      isName(next) &&
      current.withState === null &&
      current.windowState === null
    ) {
      declared.add(next.value);
      index += 1;
    }
  }

  if (remote) estimate(top());

  // Rules 4, 5 and 6.
  for (let index = 0; index < body.length; index += 1) {
    const token = body[index] as Token;
    const next = body[index + 1];

    if (isName(token) && next?.text === '(') {
      if (declarations.has(index)) continue;
      if (token.kind === 'word' && KEYWORDS.has(token.value)) continue;
      if (!functions.has(token.value)) throw refuseQuery();
      if (FORMAT_FUNCTIONS.has(token.value)) assertFormatBounded(body, index + 2);
      if (
        query.profile === 'remote' &&
        AGGREGATE_FUNCTIONS.has(token.value) &&
        usedAsWindow(body, index + 1)
      ) {
        throw refuseQuery();
      }
      continue;
    }

    if (next?.text === '.') {
      // Only the table or an alias this statement declared may qualify a column. A string or
      // number in that position is a name in disguise.
      if (!isName(token) || (token.value !== table && !declared.has(token.value))) {
        throw refuseQuery();
      }
    }
  }

  return statement.sql;
}

/**
 * Whether the FROM at `index` ends the operator `IS [NOT] DISTINCT FROM`.
 *
 * Only keywords qualify. A quoted name or a string spelling `distinct` is not the keyword, and
 * reading it as one would skip the FROM clause after it, with every source in it unchecked and
 * uncounted (#556). Every FROM this does not match is a source clause.
 */
function isDistinctOperator(body: readonly Token[], index: number): boolean {
  const keyword = (offset: number, value: string): boolean => {
    const token = body[index - offset];
    return token?.kind === 'word' && token.value === value;
  };
  if (!keyword(1, 'distinct')) return false;
  return keyword(2, 'is') || (keyword(2, 'not') && keyword(3, 'is'));
}

const FORMAT_FUNCTIONS = new Set(['printf', 'format']);

/**
 * Rule 6: the call's first argument, at `first`, is a single string literal, and none of its
 * conversions asks for a width or precision of `*` or above `maxFormatWidth`.
 *
 * Mirrors SQLite's `printf.c`: after `%`, any of the flags `-+ 0#,!`, then a width, then `.`
 * and a precision. A `%%` is a literal percent sign.
 */
function assertFormatBounded(body: readonly Token[], first: number): void {
  const format = body[first];
  const after = body[first + 1]?.text;
  if (format?.kind !== 'string' || (after !== ',' && after !== ')')) throw refuseQuery();
  const text = format.value;
  const bounded = (from: number): number => {
    let at = from;
    if (text[at] === '*') throw refuseQuery();
    while (at < text.length && /[0-9]/.test(text[at] as string)) at += 1;
    if (at > from && Number(text.slice(from, at)) > QUERY_GUARD_LIMITS.maxFormatWidth) {
      throw refuseQuery();
    }
    return at;
  };
  for (let at = text.indexOf('%'); at !== -1; at = text.indexOf('%', at)) {
    at += 1;
    if (text[at] === '%') {
      at += 1;
      continue;
    }
    while (at < text.length && '-+ 0#,!'.includes(text[at] as string)) at += 1;
    at = bounded(at);
    if (text[at] === '.') at = bounded(at + 1);
  }
}

function assertBalanced(tokens: readonly Token[]): void {
  let depth = 0;
  for (const token of tokens) {
    if (token.text === '(') depth += 1;
    if (token.text === ')') depth -= 1;
    if (depth < 0 || depth > QUERY_GUARD_LIMITS.maxDepth) throw refuseQuery();
  }
  if (depth !== 0) throw refuseQuery();
}

/** Whether the call opened at `open` is followed by OVER, optionally after a FILTER clause. */
function usedAsWindow(tokens: readonly Token[], open: number): boolean {
  const close = matching(tokens, open);
  if (close === -1) return false;
  let after = close + 1;
  if (tokens[after]?.value === 'filter' && tokens[after + 1]?.text === '(') {
    const filterClose = matching(tokens, after + 1);
    if (filterClose === -1) return false;
    after = filterClose + 1;
  }
  return tokens[after]?.value === 'over';
}

function matching(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index]?.text === '(') depth += 1;
    if (tokens[index]?.text === ')') depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}
