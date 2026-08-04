import { LoreError } from '@lorepack/core';

/**
 * Statement-shape validation, by tokenizing rather than parsing.
 *
 * This answers exactly one question, and deliberately no others: **is the input one statement
 * that begins as a SELECT?** Which tables it reads, which functions it calls and whether it
 * tries to write are questions about meaning, and the SQLite authorizer answers all of them at
 * the engine boundary, where no amount of clever text can mislead it.
 *
 * `docs/architecture/adr-sql-surface.md` records why this is a tokenizer and not a SQL parser.
 * The short version: a tokenizer has no grammar to be wrong about. It cannot reject a window
 * function it has never heard of, and it cannot be talked into believing a hostile query is
 * benign, because it forms no opinion about the query at all.
 *
 * It fails closed. Anything it cannot make sense of is rejected.
 */

/** Everything a caller may ask SQLite to do here. Anything else is not a read. */
const ALLOWED_LEADING = new Set(['select', 'with', 'values']);

export interface ValidatedStatement {
  /** The statement with any trailing separator removed, ready to prepare. */
  readonly sql: string;
  /** True when the text already bounds its own result and no LIMIT should be injected. */
  readonly hasLimit: boolean;
}

export function validateStatement(sql: string): ValidatedStatement {
  const stripped = stripCommentsAndStrings(sql);
  assertSingleStatement(stripped, sql);

  const keyword = firstKeyword(stripped.masked);
  if (keyword === null) {
    throw refuse(
      'The query is empty.',
      'Write a SELECT, for example `SELECT * FROM <table> LIMIT 10`.',
    );
  }
  if (!ALLOWED_LEADING.has(keyword)) {
    throw refuse(
      `Only SELECT is allowed here, and this statement begins with ${keyword.toUpperCase()}.`,
      'This surface is read-only by design: no model-facing tool may write, and nothing here can be made to. Use a SELECT, or `lore inspect tables` to see what a build contains.',
    );
  }
  // `WITH ... INSERT` is a real SQLite statement and begins with an allowed keyword, so the
  // leading word is not sufficient on its own. The authorizer would refuse the write anyway;
  // refusing here as well means the user gets a sentence about their query rather than an
  // opaque "authorization denied".
  if (keyword === 'with' && !containsSelectAfterCte(stripped.masked)) {
    throw refuse(
      'A WITH clause here must end in a SELECT.',
      'A common table expression followed by INSERT, UPDATE or DELETE is a write, and this surface is read-only.',
    );
  }

  return {
    sql: stripped.trimmed,
    hasLimit: /(^|[^a-z0-9_])limit([^a-z0-9_]|$)/i.test(stripped.masked),
  };
}

function refuse(message: string, remediation: string): LoreError {
  // The message never names a file, a physical table or anything about the schema: a refusal
  // is allowed to explain the rule and nothing about the machine (#77, section 19.5).
  return new LoreError('LORE_E_SQL_REJECTED', message, { remediation });
}

interface Stripped {
  /**
   * The statement with every string literal and every comment replaced by spaces of the same
   * length, so offsets still line up and nothing inside them can be mistaken for syntax.
   */
  readonly masked: string;
  /** The original text, with trailing whitespace and one optional trailing `;` removed. */
  readonly trimmed: string;
  /** Offsets of `;` characters that are genuinely statement separators. */
  readonly separators: readonly number[];
  readonly unterminated: string | null;
}

/**
 * One pass, tracking the five contexts in which a `;` is not a separator.
 *
 * Single quotes escape by doubling (`'it''s'`), which is why the closing quote is checked for
 * a following quote rather than for a preceding backslash: SQLite has no backslash escape, and
 * treating `\'` as one is a classic way to mis-tokenize a literal and lose the rest of it.
 */
function stripCommentsAndStrings(sql: string): Stripped {
  const masked: string[] = [];
  const separators: number[] = [];
  let index = 0;
  let unterminated: string | null = null;

  const closers: Record<string, string> = { '"': '"', '[': ']', '`': '`' };

  while (index < sql.length) {
    const character = sql[index] as string;

    if (character === "'") {
      const start = index;
      index += 1;
      for (;;) {
        if (index >= sql.length) {
          unterminated = 'a string literal';
          break;
        }
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      masked.push(' '.repeat(index - start));
      continue;
    }

    if (character in closers) {
      const closing = closers[character] as string;
      const start = index;
      index += 1;
      for (;;) {
        if (index >= sql.length) {
          unterminated = 'a quoted identifier';
          break;
        }
        if (sql[index] === closing) {
          if (closing === '"' && sql[index + 1] === '"') {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      // Masked like a string: an identifier may legitimately contain a semicolon, and #77 asks
      // specifically that it must not be read as one.
      masked.push(' '.repeat(index - start));
      continue;
    }

    if (character === '-' && sql[index + 1] === '-') {
      const start = index;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      masked.push(' '.repeat(index - start));
      continue;
    }

    if (character === '/' && sql[index + 1] === '*') {
      const start = index;
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      if (index >= sql.length) unterminated = 'a block comment';
      else index += 2;
      masked.push(' '.repeat(index - start));
      continue;
    }

    if (character === ';') separators.push(index);
    masked.push(character);
    index += 1;
  }

  const joined = masked.join('');
  const trimmed = sql.replace(/\s*;\s*$/, '').trim();
  return { masked: joined, trimmed, separators, unterminated };
}

function assertSingleStatement(stripped: Stripped, original: string): void {
  if (stripped.unterminated !== null) {
    throw refuse(
      `The query ends inside ${stripped.unterminated}.`,
      'Close the quote or comment. Lorepack refuses a statement it cannot read to the end rather than guessing where it stops.',
    );
  }

  // A separator is only trailing if nothing but whitespace follows it in the masked text,
  // which is what makes `SELECT 1;` acceptable and `SELECT 1; DROP TABLE t` not.
  const meaningful = stripped.separators.filter(
    (at) => stripped.masked.slice(at + 1).trim() !== '',
  );
  if (meaningful.length > 0) {
    throw refuse(
      'Only one statement may be sent at a time, and this text contains more than one.',
      'Send a single SELECT. A semicolon that separates statements is refused even when a comment appears to hide it, because comments are removed before the count.',
    );
  }
  if (original.trim() === '') {
    throw refuse(
      'The query is empty.',
      'Write a SELECT, for example `SELECT * FROM <table> LIMIT 10`.',
    );
  }
}

function firstKeyword(masked: string): string | null {
  const match = /[a-z_][a-z0-9_]*/i.exec(masked);
  return match === null ? null : match[0].toLowerCase();
}

/**
 * Whether a `WITH` statement's body is a SELECT.
 *
 * Decided by paren depth, which is the only thing that distinguishes the two cases. A common
 * table expression's body lives inside parentheses, so every `SELECT` belonging to a CTE is at
 * depth one or deeper; the statement's own verb is the first such keyword at **depth zero**.
 *
 * Scanning backwards for the last `SELECT` is the obvious approach and is wrong:
 * `WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x` ends in a SELECT and is a write.
 */
function containsSelectAfterCte(masked: string): boolean {
  const verbs = new Set(['select', 'values', 'insert', 'update', 'delete', 'replace']);
  let depth = 0;
  let seenWith = false;

  for (const token of masked.matchAll(/[a-z_][a-z0-9_]*|[()]/gi)) {
    const text = (token[0] as string).toLowerCase();
    if (text === '(') {
      depth += 1;
      continue;
    }
    if (text === ')') {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (!seenWith) {
      if (text === 'with') seenWith = true;
      continue;
    }
    if (verbs.has(text)) return text === 'select' || text === 'values';
  }
  return false;
}

/**
 * Wraps a statement so its result is bounded whatever the statement says.
 *
 * A subquery rather than an appended `LIMIT`, because appending is wrong in two ways that are
 * easy to miss: a compound `SELECT ... UNION SELECT ...` takes the limit for the whole
 * compound, and a statement that already ends in `LIMIT 1000000` would end in two limits. A
 * wrapper binds to the outermost result and cannot be argued with.
 *
 * `limit + 1` is asked for so the caller can tell "exactly this many rows" from "more than
 * this many, truncated", which is the difference between a complete answer and a partial one.
 */
export function bound(sql: string, limit: number): string {
  return `SELECT * FROM (${sql}) LIMIT ${String(limit + 1)}`;
}
