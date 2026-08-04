import type { ParserWarning } from '@lorepack/core';

/**
 * Reading a CSV means guessing two things the format does not record: what separates the
 * fields, and whether the first line names them. Both guesses are made from evidence, both
 * are written into table metadata, and both can be wrong, which is exactly why they are
 * recorded rather than assumed.
 */

/** The separators worth considering. Ordered, so a tie resolves the same way every run. */
export const DELIMITERS: readonly string[] = [',', ';', '\t', '|'];

export interface DialectDecision {
  readonly delimiter: string;
  /** How the delimiter was chosen, for metadata and for the `lore inspect` output. */
  readonly reason: string;
}

/**
 * Picks the delimiter by consistency, not by frequency.
 *
 * Counting occurrences is the obvious approach and it is wrong. A file of prose sentences
 * separated by semicolons has more commas than semicolons, but the commas fall in different
 * places on every line, while the semicolons produce the *same field count* on each. So the
 * test is: which candidate splits every sampled line into the same number of fields, with
 * more than one field? Ties go to the earlier entry in `DELIMITERS`, which puts the comma
 * first and makes the outcome deterministic rather than dependent on iteration order.
 *
 * Counting happens outside quotes, because `"Smith, John"` is one field and a naive count
 * would see a comma there and pick wrongly on a file whose real delimiter is a semicolon.
 */
export function detectDelimiter(text: string, sampleLines = 20): DialectDecision {
  const lines = sampleLogicalLines(text, sampleLines);
  if (lines.length === 0) return { delimiter: ',', reason: 'default: the file has no rows' };

  let best: { delimiter: string; fields: number } | null = null;
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
    const first = counts[0] as number;
    if (first === 0) continue;
    if (!counts.every((count) => count === first)) continue;
    // Strictly greater, so an earlier candidate wins a tie and the choice is stable.
    if (best === null || first + 1 > best.fields) best = { delimiter, fields: first + 1 };
  }

  if (best === null) {
    return {
      delimiter: ',',
      reason: 'default: no candidate produced a consistent field count',
    };
  }
  return {
    delimiter: best.delimiter,
    reason: `consistent ${String(best.fields)} fields across ${String(lines.length)} sampled rows`,
  };
}

/**
 * Splits on newlines that are not inside a quoted field.
 *
 * A quoted field may contain a newline, and a sampler that ignored that would hand the
 * delimiter detector half a record and read an inconsistency that is not there.
 */
function sampleLogicalLines(text: string, limit: number): string[] {
  const lines: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < text.length && lines.length < limit; index += 1) {
    const character = text[index] as string;
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      if (current.trim() !== '') lines.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim() !== '' && lines.length < limit) lines.push(current);
  return lines;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] as string;
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === delimiter) count += 1;
  }
  return count;
}

export interface HeaderDecision {
  readonly names: readonly string[];
  readonly hasHeader: boolean;
  readonly reason: string;
  readonly warnings: readonly ParserWarning[];
}

/**
 * Decides whether row one names the columns, and produces usable names either way.
 *
 * The rule is deliberately narrow: a header row is one where **every cell is non-empty,
 * distinct-ish text** and at least one cell in a later row of the same column parses as a
 * number or a boolean. In other words, the first row looks like labels and the body does
 * not. A file whose every column is text gets treated as having a header, because that is
 * overwhelmingly what a text-only CSV with a plausible first row is, and because the
 * decision is recorded so a reader can see it was a judgement.
 *
 * When there is no header, names are synthesized as `column_1`, `column_2`, which #74 asks
 * for by name so that two builds of the same file agree on what to call things.
 */
export function decideHeader(
  rows: readonly (readonly string[])[],
  columnCount: number,
): HeaderDecision {
  const synthesized = Array.from({ length: columnCount }, (_, index) => `column_${index + 1}`);
  const first = rows[0];
  if (first === undefined) {
    return { names: synthesized, hasHeader: false, reason: 'the file has no rows', warnings: [] };
  }

  const cells = first.map((cell) => cell.trim());
  // Every cell it *has* must be a name, but it need not have one per column. A header of two
  // names above a body row of three cells means the file has a third column nobody named,
  // and demanding an exact width would demote the header to data and mislabel everything.
  const allNamed = cells.length > 0 && cells.every((cell) => cell !== '');
  const firstRowIsData = cells.some((cell) => looksNumeric(cell) || looksBoolean(cell));

  if (!allNamed || firstRowIsData) {
    return {
      names: synthesized,
      hasHeader: false,
      reason: firstRowIsData
        ? 'row 1 contains numeric or boolean values, so it is data'
        : 'row 1 has blank cells, so it does not name the columns',
      warnings: [],
    };
  }

  const padded = Array.from(
    { length: columnCount },
    (_, index) => cells[index] ?? `column_${index + 1}`,
  );
  const { names, warnings } = disambiguate(padded);
  return {
    names,
    hasHeader: true,
    reason:
      cells.length === columnCount
        ? 'row 1 is all non-empty text'
        : `row 1 names ${String(cells.length)} of ${String(columnCount)} columns; the rest were numbered`,
    warnings,
  };
}

/**
 * Makes header names unique, and says so.
 *
 * This is the case `csv-parse`'s own `columns: true` gets wrong for our purposes: given
 * `a,a` it returns a single column and the second value silently wins. A build that drops a
 * column of the user's data without a word is precisely the "silent drop" #74 forbids, which
 * is why this parser reads rows as arrays and owns the header logic instead.
 *
 * Duplicates become `name_2`, `name_3`, and an empty name becomes its positional fallback.
 * The suffix is applied until it does not collide, so `a, a, a_2` cannot produce two `a_2`.
 */
function disambiguate(cells: readonly string[]): {
  names: string[];
  warnings: ParserWarning[];
} {
  const names: string[] = [];
  const warnings: ParserWarning[] = [];
  const used = new Set<string>();
  const duplicated = new Set<string>();

  for (const [index, cell] of cells.entries()) {
    const base = cell === '' ? `column_${index + 1}` : cell;
    if (!used.has(base)) {
      used.add(base);
      names.push(base);
      continue;
    }
    duplicated.add(base);
    let suffix = 2;
    while (used.has(`${base}_${String(suffix)}`)) suffix += 1;
    const renamed = `${base}_${String(suffix)}`;
    used.add(renamed);
    names.push(renamed);
  }

  if (duplicated.size > 0) {
    warnings.push({
      code: 'csv-duplicate-header',
      message: `These column names appear more than once and were suffixed to keep every column: ${[
        ...duplicated,
      ]
        .sort()
        .join(', ')}. No column was dropped.`,
      line: 1,
    });
  }
  return { names, warnings };
}

export function looksNumeric(value: string): boolean {
  if (value === '') return false;
  // A leading zero means an identifier, not a number, and that judgement belongs to
  // inference rather than here. `0` and `0.5` are still numbers.
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value);
}

export function looksBoolean(value: string): boolean {
  return /^(true|false)$/i.test(value);
}
