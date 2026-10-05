import { LoreError } from '../errors/index.js';

/**
 * SQLite's tokenizer, for the one purpose of knowing what a statement names.
 *
 * Mirrors `tokenize.c` closely enough that every token SQLite would see is seen here, and
 * fails closed on everything else: a byte this lexer cannot classify is refused rather than
 * skipped, because a skipped byte is exactly where a second table name would hide.
 *
 * Deliberately not a parser (`docs/architecture/adr-sql-surface.md`). It says what the words
 * are, never what the statement means.
 */

export type TokenKind =
  | 'word'
  | 'quoted'
  | 'string'
  | 'blob'
  | 'number'
  | 'operator'
  | 'comment'
  | 'space';

export interface Token {
  readonly kind: TokenKind;
  /** The token exactly as written. */
  readonly text: string;
  /**
   * The name or text it denotes, lowercased in ASCII only: a word as written, a quoted
   * identifier without its quotes, a string literal without its quotes. Empty for the rest.
   */
  readonly value: string;
  readonly start: number;
}

/** The single refusal every SQL rejection uses, so the reason cannot be probed by its wording. */
export function refuseQuery(): LoreError {
  return new LoreError(
    'LORE_E_SQL_REJECTED',
    'The query uses something this table query does not allow.',
    {
      remediation:
        'Use a single SELECT over the table named in the request: its columns, ordinary SQL functions, aliases, subqueries and common table expressions over that table. It cannot read other tables, the build catalog or the database schema. Call `describeTable` for the `sqlName` of the table and each column.',
    },
  );
}

const OPERATORS = [
  '->>',
  '||',
  '->',
  '==',
  '<>',
  '!=',
  '<=',
  '>=',
  '<<',
  '>>',
  '=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '~',
  '(',
  ')',
  ',',
  '.',
  ';',
] as const;

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const SPACE = /[ \t\n\f\r]/;

/** ASCII-only lowercasing: `toLowerCase` folds some non-ASCII letters into ASCII ones. */
function lower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/**
 * Splits `sql` into tokens. Throws the shared refusal for an unterminated literal, quote or
 * comment, a bound parameter, a non-ASCII byte outside a string literal, a number running into
 * a name, or any character SQLite would not accept as the start of a token.
 */
export function lexSql(sql: string): readonly Token[] {
  const tokens: Token[] = [];
  let at = 0;

  const push = (kind: TokenKind, start: number, value = ''): void => {
    tokens.push({ kind, text: sql.slice(start, at), value, start });
  };

  while (at < sql.length) {
    const start = at;
    const character = sql[at] as string;

    if (SPACE.test(character)) {
      while (at < sql.length && SPACE.test(sql[at] as string)) at += 1;
      push('space', start);
      continue;
    }

    if (character === '-' && sql[at + 1] === '-') {
      while (at < sql.length && sql[at] !== '\n') at += 1;
      push('comment', start);
      continue;
    }

    if (character === '/' && sql[at + 1] === '*') {
      at += 2;
      while (at < sql.length && !(sql[at] === '*' && sql[at + 1] === '/')) at += 1;
      if (at >= sql.length) throw refuseQuery();
      at += 2;
      push('comment', start);
      continue;
    }

    if (character === "'") {
      at = closeQuoted(sql, at, "'", true);
      push('string', start, lower(sql.slice(start + 1, at - 1).replaceAll("''", "'")));
      continue;
    }

    if (character === '"' || character === '`') {
      at = closeQuoted(sql, at, character, true);
      const inner = sql.slice(start + 1, at - 1).replaceAll(character + character, character);
      assertAscii(inner);
      push('quoted', start, lower(inner));
      continue;
    }

    if (character === '[') {
      const close = sql.indexOf(']', at + 1);
      if (close === -1) throw refuseQuery();
      at = close + 1;
      const inner = sql.slice(start + 1, close);
      assertAscii(inner);
      push('quoted', start, lower(inner));
      continue;
    }

    if ((character === 'x' || character === 'X') && sql[at + 1] === "'") {
      at = closeQuoted(sql, at + 1, "'", false);
      if (!/^[0-9A-Fa-f]*$/.test(sql.slice(start + 2, at - 1))) throw refuseQuery();
      if ((at - start - 3) % 2 !== 0) throw refuseQuery();
      push('blob', start);
      continue;
    }

    if (DIGIT.test(character) || (character === '.' && DIGIT.test(sql[at + 1] ?? ''))) {
      at = scanNumber(sql, at);
      if (at < sql.length && NAME_PART.test(sql[at] as string)) throw refuseQuery();
      push('number', start);
      continue;
    }

    if (NAME_START.test(character)) {
      while (at < sql.length && NAME_PART.test(sql[at] as string)) at += 1;
      const word = sql.slice(start, at);
      // `$` is a name character to SQLite, and an unusual one in a model-written query. Refused
      // so a name never differs from what a reader sees.
      if (word.includes('$')) throw refuseQuery();
      push('word', start, lower(word));
      continue;
    }

    const operator = OPERATORS.find((candidate) => sql.startsWith(candidate, at));
    if (operator !== undefined) {
      at += operator.length;
      push('operator', start);
      continue;
    }

    // Parameters (`?`, `:x`, `@x`, `$x`, `#x`), non-ASCII bytes and anything else SQLite
    // would reject or treat specially.
    throw refuseQuery();
  }

  return tokens;
}

/** Index just past the closing quote. Doubled quotes are an escape; backslash is not. */
function closeQuoted(sql: string, open: number, quote: string, doubling: boolean): number {
  let at = open + 1;
  for (;;) {
    if (at >= sql.length) throw refuseQuery();
    if (sql[at] === quote) {
      if (doubling && sql[at + 1] === quote) {
        at += 2;
        continue;
      }
      return at + 1;
    }
    at += 1;
  }
}

function scanNumber(sql: string, start: number): number {
  let at = start;
  if (sql[at] === '0' && (sql[at + 1] === 'x' || sql[at + 1] === 'X')) {
    at += 2;
    while (at < sql.length && /[0-9A-Fa-f]/.test(sql[at] as string)) at += 1;
    return at;
  }
  while (at < sql.length && DIGIT.test(sql[at] as string)) at += 1;
  if (sql[at] === '.') {
    at += 1;
    while (at < sql.length && DIGIT.test(sql[at] as string)) at += 1;
  }
  if (sql[at] === 'e' || sql[at] === 'E') {
    const sign = sql[at + 1] === '+' || sql[at + 1] === '-' ? 1 : 0;
    if (DIGIT.test(sql[at + 1 + sign] ?? '')) {
      at += 1 + sign;
      while (at < sql.length && DIGIT.test(sql[at] as string)) at += 1;
    }
  }
  return at;
}

function assertAscii(text: string): void {
  if (/[^\x20-\x7e]/.test(text)) throw refuseQuery();
}
