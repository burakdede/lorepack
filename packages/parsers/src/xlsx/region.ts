import { count, type ParserWarning, type TableValue } from '@lorepack/core';
import type { Cell } from './cells.js';
import { cellReference } from './cells.js';
import type { SheetRow } from './sheet.js';

/**
 * `A3:E120`, built **after** the sheet has been read.
 *
 * Kept out of `detectRegion` deliberately. The detector runs as soon as it has seen the
 * header, which is long before the last row is known, and computing the range there produced
 * `A1:D24` for a 500,000-row sheet: the buffered preamble's last row, stated with total
 * confidence as the extent of the table.
 */
export function rangeOf(region: Region, lastRow: number): string {
  return `${cellReference(region.firstColumn, region.headerRow)}:${cellReference(region.lastColumn, lastRow)}`;
}

/**
 * Finding the table in a sheet, conservatively.
 *
 * A worksheet is a canvas, not a table. People put a title in A1, leave a blank row, start the
 * real data at A3, and add a total row at the bottom. The detector has to find the rectangle
 * that is actually a table, and, far more importantly, has to **refuse** when it cannot.
 *
 * The refusal is the feature. Section 4.6 forbids flattening a workbook into prose, but
 * inventing a table out of a layout nobody meant as one is the other failure: it produces
 * confident, queryable, wrong data. A sheet the detector cannot read becomes a descriptive
 * node and a warning that names the sheet, which is a user telling us what they meant rather
 * than us guessing.
 */

/** Rows scanned to find the header. A title block longer than this is not a preamble. */
const MAX_PREAMBLE_ROWS = 20;

export interface Region {
  readonly headerRow: number;
  readonly firstColumn: number;
  readonly lastColumn: number;
  readonly names: readonly string[];
}

export interface Detection {
  readonly region: Region | null;
  readonly reason: string;
}

/**
 * Picks the header row and the column span from the first rows of the sheet.
 *
 * The rule: the header is the first row within the preamble whose cells are **all text**,
 * that has at least one cell, and that is followed by a row of the same width or wider. A
 * title in A1 fails the width test against the data below it; a real header does not.
 */
export function detectRegion(
  preamble: readonly SheetRow[],
  warnings: ParserWarning[],
  sheetName: string,
): Detection {
  const candidates = preamble.slice(0, MAX_PREAMBLE_ROWS);
  if (candidates.length === 0) {
    return { region: null, reason: 'the sheet is empty' };
  }

  for (const [index, row] of candidates.entries()) {
    const next = candidates[index + 1];
    if (next === undefined) break;

    const span = spanOf(row);
    const nextSpan = spanOf(next);
    if (span === null || nextSpan === null) continue;

    // A one-cell row above a wide one is a title, not a header. Saying so in a warning is
    // what makes "we ignored your first two rows" visible rather than mysterious.
    const width = span.last - span.first + 1;
    const nextWidth = nextSpan.last - nextSpan.first + 1;
    if (width < nextWidth || !row.cells.every((cell) => typeof cell.value === 'string')) {
      continue;
    }
    if (span.first !== nextSpan.first) continue;

    if (index > 0) {
      warnings.push({
        code: 'xlsx-preamble-skipped',
        message: `Sheet ${sheetName}: the table was read from row ${String(row.row + 1)}. The ${count(index, 'row')} above it did not look like a header and were not imported.`,
        line: 1,
      });
    }

    return {
      region: {
        headerRow: row.row,
        firstColumn: span.first,
        lastColumn: span.last,
        names: headerNames(row, span.first, span.last, warnings, sheetName),
      },
      reason:
        index === 0
          ? 'row 1 is a header above data'
          : `row ${String(row.row + 1)} is a header above data`,
    };
  }

  return {
    region: null,
    reason: 'no row of text sits above a row of data of the same width',
  };
}

function spanOf(row: SheetRow): { first: number; last: number } | null {
  if (row.cells.length === 0) return null;
  let first = Number.POSITIVE_INFINITY;
  let last = -1;
  for (const cell of row.cells) {
    if (cell.column < first) first = cell.column;
    if (cell.column > last) last = cell.column;
  }
  return last < 0 ? null : { first, last };
}

/**
 * Header names, positional and de-duplicated, matching the CSV parser's behaviour exactly.
 *
 * A merged header cell writes its text into the top-left cell only, so the covered columns
 * arrive empty. They get positional names rather than inheriting the merged label, because
 * repeating the label would produce several columns claiming to be the same thing.
 */
function headerNames(
  row: SheetRow,
  first: number,
  last: number,
  warnings: ParserWarning[],
  sheetName: string,
): string[] {
  const byColumn = new Map<number, Cell>();
  for (const cell of row.cells) byColumn.set(cell.column, cell);

  const used = new Set<string>();
  const duplicated = new Set<string>();
  const names: string[] = [];

  for (let column = first; column <= last; column += 1) {
    const raw = byColumn.get(column)?.value;
    const base =
      typeof raw === 'string' && raw.trim() !== ''
        ? raw.trim()
        : `column_${String(column - first + 1)}`;
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
      code: 'xlsx-duplicate-header',
      message: `Sheet ${sheetName}: these column names appear more than once and were suffixed to keep every column: ${[...duplicated].sort().join(', ')}. No column was dropped.`,
      line: 1,
    });
  }
  return names;
}

/** A row's cells laid out across the region's columns, with gaps as nulls. */
export function rowValues(row: SheetRow, first: number, last: number): (TableValue | null)[] {
  const values: (TableValue | null)[] = new Array(last - first + 1).fill(null);
  for (const cell of row.cells) {
    if (cell.column < first || cell.column > last) continue;
    values[cell.column - first] = cell.value;
  }
  return values;
}
