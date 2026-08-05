import {
  type ArtifactParser,
  count,
  LoreError,
  type LoreNode,
  type ParsedArtifact,
  type ParsedColumn,
  type ParsedTable,
  type ParseInput,
  type ParserWarning,
  type TableValue,
} from '@lorepack/core';
import { buildArtifact, NodeBuilder } from '../shared/builder.js';
import { ColumnAccumulator, unifyCellTypes } from '../table/infer.js';
import { cellReference } from './cells.js';
import { detectRegion, rangeOf, rowValues } from './region.js';
import { SHEET_LIMITS, type SheetRow, streamSheet } from './sheet.js';
import { readWorkbookParts } from './workbook.js';
import { openPackage } from './zip.js';

export const XLSX_PARSER_ID = 'xlsx' as const;
export const XLSX_PARSER_VERSION = '0.1.0' as const;

export const XLSX_LIMITS = {
  maxColumns: SHEET_LIMITS.maxColumns,
  maxRows: SHEET_LIMITS.maxRows,
  /** Sheets read from one workbook. Beyond this, the file is not a document. */
  maxSheets: 256,
  /** Bumping this invalidates every cached parse, like a parser version. */
  normalizationVersion: 1,
} as const;

/** Rows held before the header is decided, which is all the detector needs. */
const PREAMBLE_ROWS = 24;

/**
 * XLSX to typed tables, with sheet and cell-range provenance.
 *
 * Read by a reader of our own over `yauzl` and `sax`, not by a library. The decision, the
 * measured matrix and the reasoning are in `docs/architecture/adr-xlsx-parser.md`: nothing
 * maintained returned formula text, cell addresses, merge ranges and bounded memory together,
 * and an unmaintained parser of untrusted binary input is the worst place to accept a
 * dependency with no security-fix pipeline.
 *
 * One table per sheet, at most. A sheet whose layout the detector cannot read becomes a
 * descriptive node and a warning naming the sheet, never an invented table and never a prose
 * dump of its cells. Both of those failures are silent, and this is the one place in the
 * pipeline where being confidently wrong is worse than being unhelpful.
 */
export const xlsxParser: ArtifactParser = {
  id: XLSX_PARSER_ID,
  version: XLSX_PARSER_VERSION,

  supports(input) {
    return (
      /\.xlsx$/i.test(input.relativePath) ||
      input.mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  },

  async parse(input: ParseInput): Promise<ParsedArtifact> {
    assertNotLegacyXls(input);

    const warnings: ParserWarning[] = [];
    const pkg = await openPackage(input.bytes, input.displayPath);
    const tables: ParsedTable[] = [];
    const sheetSummaries: { name: string; rows: number; note: string }[] = [];

    try {
      const parts = await readWorkbookParts(pkg);
      if (parts.sheets.length > XLSX_LIMITS.maxSheets) {
        throw new LoreError(
          'LORE_E_ENVELOPE_EXCEEDED',
          `${input.displayPath} has ${count(parts.sheets.length, 'sheet')}, above the supported limit of ${String(XLSX_LIMITS.maxSheets)}.`,
          {
            remediation: 'Split the workbook. Each sheet becomes its own table in the build.',
            path: input.displayPath,
          },
        );
      }
      if (parts.date1904) {
        // Announced rather than handled quietly. Reading this workbook as 1900 would shift
        // every date by four years and one day and look entirely plausible, so a reader who
        // is checking dates deserves to know which epoch was applied.
        warnings.push({
          code: 'xlsx-1904-dates',
          message:
            'This workbook uses the 1904 date system, so dates were converted from that epoch rather than 1900.',
          line: 1,
        });
      }

      for (const sheet of parts.sheets) {
        const built = await readSheetTable(pkg, sheet, parts, input, warnings);
        sheetSummaries.push({ name: sheet.name, rows: built.rows, note: built.note });
        if (built.table !== null) tables.push(built.table);
      }
    } finally {
      pkg.close();
    }

    return {
      artifact: buildArtifact(
        input,
        { id: XLSX_PARSER_ID, version: XLSX_PARSER_VERSION },
        {
          title: titleOf(input),
          metadata: {
            sheets: sheetSummaries.map((sheet) => sheet.name),
            date1904: false,
            normalizationVersion: XLSX_LIMITS.normalizationVersion,
          },
        },
      ),
      nodes: buildNodes(input, sheetSummaries, tables),
      warnings,
      ...(tables.length === 0 ? {} : { tables }),
    };
  },
};

/**
 * The legacy binary format, refused by name.
 *
 * `.xls` is OLE compound storage, a completely different format that shares three letters.
 * Letting it reach the ZIP reader produces a message about a central directory, which sends
 * someone hunting for corruption rather than reaching for save-as.
 */
function assertNotLegacyXls(input: ParseInput): void {
  if (!/\.xls$/i.test(input.relativePath)) return;
  throw new LoreError(
    'LORE_E_UNSUPPORTED_FORMAT',
    `${input.displayPath} is a legacy .xls file, which is a different format from .xlsx.`,
    {
      remediation:
        'Open it and save as .xlsx, then rebuild. The two share a name and nothing else, so Lorepack refuses rather than guessing.',
      path: input.displayPath,
    },
  );
}

interface SheetResult {
  readonly table: ParsedTable | null;
  readonly rows: number;
  readonly note: string;
}

async function readSheetTable(
  pkg: Package_,
  sheet: { name: string; part: string },
  parts: Awaited<ReturnType<typeof readWorkbookParts>>,
  input: ParseInput,
  warnings: ParserWarning[],
): Promise<SheetResult> {
  const context = {
    sharedStrings: parts.sharedStrings,
    dateStyles: parts.dateStyles,
    date1904: parts.date1904,
  };

  // Two passes over one sheet would mean decompressing it twice, so the preamble is buffered
  // until the header is decided and the rest is consumed as it arrives.
  const preamble: SheetRow[] = [];
  let region: ReturnType<typeof detectRegion>['region'] = null;
  let reason = 'the sheet is empty';
  let lastRow = 0;
  let decided = false;

  const values: TableValue[][] = [];
  /**
   * Which columns ever held an error cell, rather than a flag per cell.
   *
   * A parallel `boolean[][]` is the obvious shape and costs 500,000 extra arrays at the
   * envelope for information that is only ever read per column. A set of column indices says
   * the same thing: a column containing `#REF!` anywhere cannot be typed numerically.
   */
  const errorColumns = new Set<number>();
  const formulas: string[] = [];

  let lastDataRow = 0;
  const take = (row: SheetRow): void => {
    lastRow = Math.max(lastRow, row.row);
    for (const cell of row.cells) {
      if (cell.formula !== undefined && formulas.length < 1000) {
        formulas.push(`${cellReference(cell.column, cell.row)}=${cell.formula}`);
      }
    }
    if (!decided) {
      preamble.push(row);
      if (preamble.length < PREAMBLE_ROWS) return;
      decided = true;
      const detection = detectRegion(preamble, warnings, sheet.name);
      region = detection.region;
      reason = detection.reason;
      if (region !== null) {
        for (const buffered of preamble) {
          if (buffered.row > region.headerRow && collect(buffered, region, values, errorColumns)) {
            lastDataRow = buffered.row;
          }
        }
      }
      return;
    }
    if (region !== null && collect(row, region, values, errorColumns)) lastDataRow = row.row;
  };

  /**
   * The row guard aborts the stream, and that abort is the memory bound (#242).
   *
   * It is thrown from inside the SAX handler on purpose: stopping mid-sheet is what keeps a
   * 5,000,000-row sheet from being accumulated before anyone can object. So it stays a throw,
   * and is turned into a not-imported sheet **here**, where the stream has already stopped.
   * Warning without stopping would keep the message and lose the bound, which is the wrong
   * half to keep.
   */
  let content: Awaited<ReturnType<typeof streamSheet>>;
  try {
    content = await streamSheet(pkg, sheet.part, context, input.displayPath, sheet.name, take);
  } catch (cause) {
    if (!(cause instanceof LoreError) || cause.code !== 'LORE_E_ENVELOPE_EXCEEDED') throw cause;
    const reason = `it has more than the ${count(XLSX_LIMITS.maxRows, 'row')} Lorepack imports`;
    warnings.push({
      code: 'xlsx-too-many-rows',
      message: `Sheet ${sheet.name} was not imported as a table because ${reason}. Split it, or filter it to the rows the project needs. Every row is imported into the build and served from it.`,
      line: 1,
    });
    return { table: null, rows: 0, note: reason };
  }

  // A sheet shorter than the preamble never triggered the decision above.
  if (!decided) {
    const detection = detectRegion(preamble, warnings, sheet.name);
    region = detection.region;
    reason = detection.reason;
    if (region !== null) {
      for (const buffered of preamble) {
        if (buffered.row > region.headerRow && collect(buffered, region, values, errorColumns)) {
          lastDataRow = buffered.row;
        }
      }
    }
  }

  if (region === null) {
    warnings.push({
      code: 'xlsx-no-table',
      message: `Sheet ${sheet.name} was not imported as a table because ${reason}. Its cells are described rather than guessed at.`,
      line: 1,
    });
    return { table: null, rows: content.rows, note: reason };
  }

  const found: NonNullable<typeof region> = region;
  const width = found.lastColumn - found.firstColumn + 1;
  if (width > XLSX_LIMITS.maxColumns) {
    // The same answer as a sheet whose layout could not be read, twenty lines above: a
    // warning and a description, not a failed build (#242). A sheet laid out perfectly and
    // found too wide is better understood than one that could not be laid out at all, so
    // failing harder for it was never defensible.
    const reason = `it has ${count(width, 'column')}, above the supported limit of ${String(XLSX_LIMITS.maxColumns)}`;
    warnings.push({
      code: 'xlsx-too-many-columns',
      message: `Sheet ${sheet.name} was not imported as a table because ${reason}. Split it into narrower tables. The limit matches Cloudflare D1, so a table above it could not be deployed either.`,
      line: 1,
    });
    return { table: null, rows: content.rows, note: reason };
  }

  if (content.merges.length > 0) {
    // Merges are reported rather than reconstructed. A merged cell writes its text into the
    // top-left of the range and leaves the rest empty, so the columns it covers arrive with
    // gaps. Filling them in would be inventing values the file does not contain.
    warnings.push({
      code: 'xlsx-merged-cells',
      message: `Sheet ${sheet.name} has ${count(content.merges.length, 'merged range')} (${content.merges.slice(0, 5).join(', ')}). A merged cell holds its value in the top-left cell only, so the cells it covers were imported as empty rather than filled in.`,
      line: 1,
    });
  }

  const range = rangeOf(found, Math.max(lastDataRow, found.headerRow));
  const columns = summarizeColumns(found.names, values, errorColumns);
  return {
    table: {
      tableId: `${input.artifactId}#${slugForId(sheet.name)}`,
      name: sheet.name,
      sheet: sheet.name,
      columns,
      rows: values,
      locator: {
        artifactId: input.artifactId,
        relativePath: input.relativePath,
        // Section 10.8: a queried row traces back to a sheet and a cell range, not to an
        // ordinal in a file that has several tables in it.
        sheet: sheet.name,
        cellRange: range,
      },
      metadata: {
        sheet: sheet.name,
        cellRange: range,
        headerRow: found.headerRow + 1,
        headerReason: reason,
        mergedRanges: content.merges,
        // Text only, and never evaluated. Section 12.6 step 5.
        formulas,
        date1904: parts.date1904,
        normalizationVersion: XLSX_LIMITS.normalizationVersion,
      },
    },
    rows: values.length,
    note: reason,
  };
}

/** Lays one row out across the region. Returns whether it counted as a data row. */
function collect(
  row: SheetRow,
  region: { firstColumn: number; lastColumn: number },
  values: TableValue[][],
  errorColumns: Set<number>,
): boolean {
  const laid = rowValues(row, region.firstColumn, region.lastColumn);
  // A row that is entirely empty inside the region is a spacer, not a row of nulls.
  if (laid.every((value) => value === null)) return false;
  for (const cell of row.cells) {
    if (cell.isError && cell.column >= region.firstColumn && cell.column <= region.lastColumn) {
      errorColumns.add(cell.column - region.firstColumn);
    }
  }
  values.push(laid as TableValue[]);
  return true;
}

function summarizeColumns(
  names: readonly string[],
  values: readonly TableValue[][],
  errorColumns: ReadonlySet<number>,
): ParsedColumn[] {
  return names.map((name, index) => {
    const accumulator = new ColumnAccumulator();
    let nullable = false;
    let type: ReturnType<typeof unifyCellTypes> | null = null;
    // One pass per column over the rows in place, rather than materialising a copy of the
    // column first: at the envelope that copy is another array of half a million values.
    for (const row of values) {
      const value = row[index] ?? null;
      if (value === null) nullable = true;
      accumulator.add(value);
      type = type === null ? unifyCellTypes([value], []) : widen(type, value);
    }
    return {
      name,
      type: errorColumns.has(index) ? 'text' : (type ?? 'unknown'),
      nullable,
      statistics: accumulator.result(),
    };
  });
}

/** Folds one more value into a column's running type, with the same rules as `unifyCellTypes`. */
function widen(
  current: ReturnType<typeof unifyCellTypes>,
  value: TableValue,
): ReturnType<typeof unifyCellTypes> {
  if (value === null) return current;
  const kind = unifyCellTypes([value], []);
  if (current === 'unknown') return kind;
  if (kind === current) return current;
  if ((current === 'integer' && kind === 'real') || (current === 'real' && kind === 'integer')) {
    return 'real';
  }
  return 'text';
}

/**
 * One node per sheet plus a document root.
 *
 * A sheet with a table gets a description of it, exactly as CSV does, so the two formats are
 * found the same way by search. A sheet without one gets a node saying so and why, which is
 * the honest alternative to either silence or a wall of cell values.
 */
function buildNodes(
  input: ParseInput,
  sheets: readonly { name: string; rows: number; note: string }[],
  tables: readonly ParsedTable[],
): LoreNode[] {
  const builder = new NodeBuilder(input);
  const title = titleOf(input);
  const root = builder.add({
    ordinalPath: [0],
    kind: 'document',
    title,
    metadata: { sheets: sheets.map((sheet) => sheet.name) },
  });

  for (const [index, sheet] of sheets.entries()) {
    const table = tables.find((one) => one.sheet === sheet.name);
    builder.add({
      ordinalPath: [0, index + 1],
      kind: 'sheet',
      parentId: root.id,
      title: sheet.name,
      headingPath: [sheet.name],
      text: table === undefined ? describeUnread(sheet) : describeTable(table),
      metadata:
        table === undefined
          ? { sheet: sheet.name, imported: false, reason: sheet.note }
          : {
              sheet: sheet.name,
              imported: true,
              tableId: table.tableId,
              cellRange: table.metadata.cellRange,
              rowCount: table.rows.length,
            },
    });
  }
  return builder.nodes as LoreNode[];
}

function describeTable(table: ParsedTable): string {
  const columns = table.columns
    .map((column) => `${column.name} (${column.type}${column.nullable ? ', nullable' : ''})`)
    .join(', ');
  const sample = table.rows
    .slice(0, 5)
    .map((row) => row.map((value) => (value === null ? '' : String(value))).join(' | '))
    .join('\n');
  return [
    `Sheet ${table.name} at ${String(table.metadata.cellRange)}: ${count(table.rows.length, 'row')}, ${count(table.columns.length, 'column')}.`,
    `Columns: ${columns}.`,
    sample === '' ? '' : `First rows:\n${sample}`,
  ]
    .filter((part) => part !== '')
    .join('\n');
}

function describeUnread(sheet: { name: string; rows: number; note: string }): string {
  return `Sheet ${sheet.name} holds ${count(sheet.rows, 'row')} but was not imported as a table: ${sheet.note}. Its contents are in the workbook and can be read there.`;
}

function titleOf(input: ParseInput): string {
  const filename = input.relativePath.split('/').at(-1) ?? input.relativePath;
  return filename.replace(/\.[^.]+$/, '') || filename;
}

/** A sheet name reduced to something safe to put in a table id. Identity is the path plus this. */
function slugForId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'sheet' : slug;
}

type Package_ = Awaited<ReturnType<typeof openPackage>>;
