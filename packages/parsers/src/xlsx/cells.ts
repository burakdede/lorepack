import type { TableValue } from '@lorepack/core';

/**
 * Cell addresses, and the decoding of one cell's value.
 *
 * Addresses matter more here than in CSV: section 10.8 wants cell-range provenance, so a row
 * has to be traceable to `Sheet1!B4:E4` rather than to "row 4 of something".
 */

export interface Cell {
  /** Zero-based, from the `r` attribute rather than from position: gaps are not shifts. */
  readonly column: number;
  readonly row: number;
  readonly value: TableValue;
  /** The formula as written, never evaluated. Absent on an ordinary cell. */
  readonly formula?: string;
  /** True for `t="e"`: the value is an error token such as `#REF!`, kept as itself. */
  readonly isError: boolean;
}

/** `AB12` to a zero-based column and row. Returns null for a reference we cannot read. */
export function parseReference(reference: string): { column: number; row: number } | null {
  const match = /^([A-Z]+)(\d+)$/.exec(reference);
  if (match === null) return null;
  const letters = match[1] as string;
  let column = 0;
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64);
  return { column: column - 1, row: Number(match[2]) - 1 };
}

/** Zero-based column index back to letters, for the locators a reader sees. */
export function columnLetters(column: number): string {
  let remaining = column + 1;
  let letters = '';
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    remaining = Math.floor((remaining - remainder) / 26);
  }
  return letters;
}

export function cellReference(column: number, row: number): string {
  return `${columnLetters(column)}${String(row + 1)}`;
}

/**
 * The two Excel epochs, both accounting for a bug Lotus 1-2-3 shipped in 1983.
 *
 * The 1900 system believes 1900 was a leap year. It was not: divisible by 100 and not by 400.
 * Excel kept the bug for compatibility, so serial 60 is a day that never existed and every
 * serial after it is one too high. Basing at **December 30th, 1899** rather than January 1st,
 * 1900 cancels the off-by-one for every date from March 1900 onward, which is every date
 * anyone has in a spreadsheet. Dates in January and February 1900 remain ambiguous in the
 * format itself and are not something this can fix.
 *
 * The 1904 system has no such bug and simply counts from January 1st, 1904.
 */
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
const MS_PER_DAY = 86_400_000;

/**
 * An Excel serial to ISO text.
 *
 * Text rather than a `Date`, and date-only when the serial has no fractional part, because a
 * spreadsheet cell holding `2026-03-01` means that day and not midnight in some timezone.
 * Adding a time nobody wrote is inventing precision.
 */
export function serialToIso(serial: number, date1904: boolean): string {
  const epoch = date1904 ? EPOCH_1904 : EPOCH_1900;
  const milliseconds = Math.round(serial * MS_PER_DAY);
  const iso = new Date(epoch + milliseconds).toISOString();
  const hasTime = Math.abs(serial - Math.trunc(serial)) > 1e-9;
  return hasTime ? iso.replace('.000Z', 'Z') : iso.slice(0, 10);
}

export interface DecodeContext {
  readonly sharedStrings: readonly string[];
  readonly dateStyles: ReadonlySet<number>;
  readonly date1904: boolean;
}

/**
 * One cell's raw XML pieces to a value.
 *
 * The `t` attribute carries most of the answer, and its absence means a number. The one case
 * that is not in the cell at all is a date, which is a number wearing a style.
 */
export function decodeCell(
  type: string | undefined,
  style: string | undefined,
  raw: string,
  inline: string,
  context: DecodeContext,
): { value: TableValue; isError: boolean } {
  switch (type) {
    case 's': {
      const index = Number(raw);
      // A damaged shared table costs this cell and nothing else.
      return { value: context.sharedStrings[index] ?? '', isError: false };
    }
    case 'inlineStr':
      return { value: inline, isError: false };
    case 'str':
      // A formula that returned text. The cached result, which is content like any other.
      return { value: raw, isError: false };
    case 'b':
      return { value: raw === '1', isError: false };
    case 'e':
      // `#REF!` and friends kept as their own text. Coercing to null would claim the cell is
      // empty, and coercing to a bare string would let it read as ordinary data; either way
      // a reader could not tell a broken formula from a real value.
      return { value: raw, isError: true };
    default: {
      if (raw === '') return { value: null, isError: false };
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) return { value: raw, isError: false };
      if (style !== undefined && context.dateStyles.has(Number(style))) {
        return { value: serialToIso(numeric, context.date1904), isError: false };
      }
      return { value: numeric, isError: false };
    }
  }
}
