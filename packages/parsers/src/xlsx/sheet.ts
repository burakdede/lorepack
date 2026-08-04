import { count, LoreError } from '@lorepack/core';
import { type Cell, type DecodeContext, decodeCell, parseReference } from './cells.js';
import type { Package } from './zip.js';

/**
 * One worksheet, streamed row by row.
 *
 * Rows are handed to a callback rather than returned as an array, which is what keeps the
 * envelope affordable: the ADR measured 85 MB peak for 500,000 rows across two million cells,
 * and that number only holds if nothing accumulates the sheet.
 */

export const SHEET_LIMITS = {
  /** Matches D1 and the CSV parser, so a table that imports here can be projected later. */
  maxColumns: 100,
  /**
   * Imported **data** rows, exactly as the CSV parser counts them.
   *
   * The guard below fires a little later than this, because a sheet row is not a data row: a
   * title block and a header sit above the table and are read but never imported. Counting
   * them against the limit would refuse a workbook holding exactly the envelope, which is the
   * one it should accept. The allowance is bounded, so the guard still bounds memory.
   */
  maxRows: 500_000,
  /** How many non-data rows may precede the table before the guard stops allowing for them. */
  preambleAllowance: 32,
} as const;

export interface SheetRow {
  /** Zero-based sheet row, from the `r` attribute, so a skipped row is a gap and not a shift. */
  readonly row: number;
  readonly cells: readonly Cell[];
}

export interface SheetContent {
  readonly merges: readonly string[];
  readonly rows: number;
}

export async function streamSheet(
  pkg: Package,
  part: string,
  context: DecodeContext,
  displayPath: string,
  sheetName: string,
  onRow: (row: SheetRow) => void,
): Promise<SheetContent> {
  const merges: string[] = [];
  let rowCount = 0;
  let rowIndex = -1;
  let cells: Cell[] = [];

  let current: { reference: string; type?: string; style?: string } | null = null;
  let inValue = false;
  let inFormula = false;
  let inInline = false;
  let value = '';
  let formula = '';
  let inline = '';

  await pkg.readXml(part, {
    open: (name, attributes) => {
      switch (name) {
        case 'row': {
          const declared = attributes.r;
          rowIndex = declared === undefined ? rowIndex + 1 : Number(declared) - 1;
          cells = [];
          rowCount += 1;
          if (rowCount > SHEET_LIMITS.maxRows + SHEET_LIMITS.preambleAllowance) {
            throw new LoreError(
              'LORE_E_ENVELOPE_EXCEEDED',
              `${displayPath}, sheet ${sheetName}, has more than the ${count(SHEET_LIMITS.maxRows, 'row')} Lorepack imports.`,
              {
                remediation:
                  'Split the sheet, or filter it to the rows the project needs. Every row is imported into the build and served from it.',
                path: displayPath,
              },
            );
          }
          return;
        }
        case 'c':
          current = {
            reference: attributes.r ?? '',
            ...(attributes.t === undefined ? {} : { type: attributes.t }),
            ...(attributes.s === undefined ? {} : { style: attributes.s }),
          };
          value = '';
          formula = '';
          inline = '';
          return;
        case 'v':
          inValue = true;
          return;
        case 'f':
          inFormula = true;
          return;
        case 'is':
          inInline = true;
          return;
        case 'mergeCell':
          if (attributes.ref !== undefined) merges.push(attributes.ref);
          return;
        default:
          return;
      }
    },
    text: (text) => {
      // Accumulated rather than assigned: a stream splits long text across events.
      if (inValue) value += text;
      else if (inFormula) formula += text;
      else if (inInline) inline += text;
    },
    close: (name) => {
      switch (name) {
        case 'v':
          inValue = false;
          return;
        case 'f':
          inFormula = false;
          return;
        case 'is':
          inInline = false;
          return;
        case 'c': {
          if (current === null) return;
          const at = parseReference(current.reference);
          const decoded = decodeCell(current.type, current.style, value, inline, context);
          if (at !== null && decoded.value !== null) {
            cells.push({
              column: at.column,
              row: at.row,
              value: decoded.value,
              // Stored as text and never evaluated, which is section 12.6 step 5. Lorepack
              // has no formula engine and must never appear to have one.
              ...(formula === '' ? {} : { formula }),
              isError: decoded.isError,
            });
          }
          current = null;
          return;
        }
        case 'row':
          if (cells.length > 0) onRow({ row: rowIndex, cells });
          return;
        default:
          return;
      }
    },
  });

  return { merges, rows: rowCount };
}
