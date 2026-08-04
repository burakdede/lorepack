import type { ColumnStatistics, ColumnTypeName, TableValue } from '@lorepack/core';
import { looksBoolean, looksNumeric } from '../csv/dialect.js';

/**
 * Conservative type inference, and the statistics that come with it.
 *
 * Shared by every format that produces a table. #75 requires XLSX to behave *exactly* as CSV
 * does, and the only way to guarantee that is one implementation: two that agree today would
 * disagree the first time either is touched.
 *
 * Architecture section 12.6 makes this a correctness property rather than a nicety: a column
 * of postal codes read as integers loses `00123` forever, and no downstream query can get it
 * back. So every rule here is written to *refuse* a type, not to find one. When two readings
 * are possible, `text` wins. When one value in ten thousand disagrees with the other nine
 * thousand nine hundred and ninety nine, `text` wins.
 *
 * That bias has a real cost: a column of prices where one cell says `n/a` stays text, and a
 * user has to cast it in SQL. That is the right trade. Casting text to a number in a query is
 * a keystroke; recovering a leading zero that the build discarded is impossible.
 */

/** How many rows are looked at before a type is decided. Recorded in table metadata. */
export const INFERENCE_SAMPLE_ROWS = 1000;

/** Above this many distinct values, the count stops being exact and says so. */
const DISTINCT_EXACT_LIMIT = 10_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Values that mean "no value". Matched case-insensitively after trimming.
 *
 * Kept short on purpose. `NULL` and `N/A` are conventions common enough to be safe;
 * `-`, `?` and `none` are real data in some column somewhere, and treating them as absent
 * would be inventing truth.
 */
const NULL_TOKENS = new Set(['', 'null', 'n/a', 'na']);

export function isNullToken(value: string): boolean {
  return NULL_TOKENS.has(value.trim().toLowerCase());
}

/**
 * Decides one column's type from a bounded sample.
 *
 * The order matters. Each check is asked "could every non-null value in this column be
 * this?", starting from the most specific, and the first unanimous answer wins. Anything
 * short of unanimous falls through to `text`.
 */
export function inferType(values: readonly string[]): ColumnTypeName {
  const present = values.filter((value) => !isNullToken(value));
  if (present.length === 0) return 'unknown';

  if (present.every((value) => looksBoolean(value.trim()))) return 'boolean';
  if (present.every((value) => isUnambiguousDate(value.trim()))) return 'date';
  if (present.every((value) => isSafeInteger(value.trim()))) return 'integer';
  if (present.every((value) => isSafeReal(value.trim()))) return 'real';
  return 'text';
}

/**
 * ISO-8601 shapes only, which is what #74 asks for and what honesty allows.
 *
 * `03/04/2026` is the fourth of March in one country and the third of April in another, and
 * the file does not say which. Guessing produces a date column that is wrong for half the
 * world's data and looks right to everyone. It stays text.
 */
function isUnambiguousDate(value: string): boolean {
  if (!ISO_DATE.test(value) && !ISO_DATETIME.test(value)) return false;
  // The shape can be right and the date impossible: `2026-02-30` matches the pattern.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && (year % 4 === 0 && year % 100 !== 0) === (year % 400 !== 0)) return 29;
  return lengths[month - 1] as number;
}

/**
 * An integer that survives the round trip, which is a stricter question than "is it digits".
 *
 * Three refusals, each of which has destroyed real data somewhere:
 *
 * - **Leading zeros.** `00123` is a postal code, a phone extension or a part number. Stored
 *   as an integer it comes back `123` and the original is gone.
 * - **A leading `+`.** `+441632960000` is a phone number wearing a plus sign.
 * - **Beyond `Number.MAX_SAFE_INTEGER`.** A 19-digit identifier parses happily and comes back
 *   off by a few, silently. Long identifiers are the single most common such column.
 */
function isSafeInteger(value: string): boolean {
  if (!/^-?\d+$/.test(value)) return false;
  if (/^-?0\d/.test(value)) return false;
  if (!Number.isSafeInteger(Number(value))) return false;
  return true;
}

function isSafeReal(value: string): boolean {
  if (!looksNumeric(value)) return false;
  // A value written as a plain integer is judged by the integer rules even here. Otherwise
  // a 19-digit identifier that `isSafeInteger` correctly refused would fall through to
  // `real` and lose exactly the precision the refusal was protecting.
  if (/^[+-]?\d+$/.test(value)) return isSafeInteger(value);
  // Same leading-zero rule: `0.5` is a number, `007.5` is a label that happens to have a dot.
  if (/^[+-]?0\d/.test(value)) return false;
  if (value.startsWith('+')) return false;
  return Number.isFinite(Number(value));
}

/**
 * Converts a cell to its stored value, given the column's decided type.
 *
 * Only ever called with a type that inference already proved every value satisfies, so this
 * cannot be where a coercion goes wrong. If a later row disagrees with the sampled type, the
 * caller widens the column to text and re-reads rather than forcing a value through here.
 */
export function coerce(value: string, type: ColumnTypeName): TableValue {
  if (isNullToken(value)) return null;
  const trimmed = value.trim();
  switch (type) {
    case 'boolean':
      return trimmed.toLowerCase() === 'true';
    case 'integer':
    case 'real':
      return Number(trimmed);
    // A date is stored as its ISO text. SQLite has no date type, D1 has no date type, and
    // inventing an epoch here would make `min` and `max` depend on a timezone that the file
    // never stated. ISO text sorts correctly as text, which is the whole point of ISO.
    case 'date':
      return trimmed;
    default:
      return value;
  }
}

/** Whether a value read later still fits the type decided from the sample. */
export function fitsType(value: string, type: ColumnTypeName): boolean {
  if (isNullToken(value)) return true;
  const trimmed = value.trim();
  switch (type) {
    case 'boolean':
      return looksBoolean(trimmed);
    case 'date':
      return isUnambiguousDate(trimmed);
    case 'integer':
      return isSafeInteger(trimmed);
    case 'real':
      return isSafeReal(trimmed);
    case 'unknown':
      return isNullToken(value);
    default:
      return true;
  }
}

/**
 * Accumulates per-column statistics in one pass.
 *
 * One pass because the envelope is 500,000 rows and a second pass over every value to count
 * distincts would double the import. The distinct set stops growing at `DISTINCT_EXACT_LIMIT`
 * and the result says whether it is exact, so a caller reading `distinctEstimate: 10000` can
 * tell "exactly ten thousand" from "at least ten thousand".
 */
export class ColumnAccumulator {
  #nullCount = 0;
  #distinct = new Set<string>();
  #distinctExact = true;
  #min: TableValue | undefined;
  #max: TableValue | undefined;

  add(value: TableValue): void {
    if (value === null) {
      this.#nullCount += 1;
      return;
    }
    if (this.#distinctExact) {
      this.#distinct.add(String(value));
      if (this.#distinct.size > DISTINCT_EXACT_LIMIT) {
        this.#distinctExact = false;
        // Dropped rather than kept: holding 500,000 distinct strings to report a number
        // nobody can act on is how an importer runs out of memory at the envelope.
        this.#distinct = new Set();
      }
    }
    if (this.#min === undefined || compare(value, this.#min) < 0) this.#min = value;
    if (this.#max === undefined || compare(value, this.#max) > 0) this.#max = value;
  }

  result(): ColumnStatistics {
    return {
      nullCount: this.#nullCount,
      distinctEstimate: this.#distinctExact ? this.#distinct.size : DISTINCT_EXACT_LIMIT,
      distinctIsExact: this.#distinctExact,
      ...(this.#min === undefined ? {} : { min: this.#min }),
      ...(this.#max === undefined ? {} : { max: this.#max }),
    };
  }
}

function compare(left: TableValue, right: TableValue): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

/**
 * A column's type when the cells arrive **already typed**, as they do from a spreadsheet.
 *
 * XLSX does not need the string-sniffing above: Excel already knows a cell holds a number, a
 * boolean or a date, and #75 requires the outcome to match CSV's rules exactly. It does,
 * because both obey the same principle: a column is a type only if **every** value in it is,
 * and mixed columns are text. A leading-zero identifier is stored by Excel as a string cell,
 * so it arrives as text without anything here needing to know it is special.
 *
 * The one addition is error cells. `#REF!` in a column of numbers means the column is not
 * reliably numeric, and typing it `real` would either drop the error or coerce it to `NaN`.
 */
export function unifyCellTypes(
  values: readonly TableValue[],
  errors: readonly boolean[],
): ColumnTypeName {
  let seen: ColumnTypeName | null = null;
  for (const [index, value] of values.entries()) {
    if (value === null) continue;
    if (errors[index] === true) return 'text';
    const kind = kindOf(value);
    if (seen === null) {
      seen = kind;
      continue;
    }
    if (seen === kind) continue;
    // `integer` and `real` are the one pair worth widening rather than abandoning: a column
    // of 1, 2 and 2.5 is genuinely numeric, and calling it text would be over-cautious in a
    // way that loses arithmetic for no gain.
    if ((seen === 'integer' && kind === 'real') || (seen === 'real' && kind === 'integer')) {
      seen = 'real';
      continue;
    }
    return 'text';
  }
  return seen ?? 'unknown';
}

function kindOf(value: Exclude<TableValue, null>): ColumnTypeName {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'real';
  // A date arrives from the sheet reader as ISO text, which is also how it is stored.
  return /^\d{4}-\d{2}-\d{2}(T|$)/.test(value) ? 'date' : 'text';
}
