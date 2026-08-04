import {
  type ArtifactParser,
  type ColumnTypeName,
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
import { parse as parseCsv } from 'csv-parse/sync';
import { buildArtifact, NodeBuilder } from '../shared/builder.js';
import { decodeUtf8Strict } from '../shared/text.js';
import { DELIMITERS, decideHeader, detectDelimiter } from './dialect.js';
import { ColumnAccumulator, coerce, fitsType, INFERENCE_SAMPLE_ROWS, inferType } from './infer.js';

export const CSV_PARSER_ID = 'csv' as const;
export const CSV_PARSER_VERSION = '0.1.0' as const;

/**
 * Hard limits, mirroring `limits.maxTableRows` and `limits.maxTableColumns` in the config.
 *
 * Duplicated here rather than threaded through `ParseInput` because a parser is a pure
 * function of its bytes and takes no configuration, which is what makes it fixture-testable.
 * The column limit matches D1's, so a table that imports locally can be projected in Phase 6
 * rather than failing there for the first time.
 */
export const CSV_LIMITS = {
  maxColumns: 100,
  maxRows: 500_000,
  inferenceSampleRows: INFERENCE_SAMPLE_ROWS,
  /** Bumping this invalidates every cached parse, like a parser version. */
  normalizationVersion: 1,
} as const;

/** How many rows `describeTable` shows as an example. Small: this is a shape, not a preview. */
const SAMPLE_ROWS = 5;

/**
 * CSV to a typed table, never to prose.
 *
 * Architecture section 4.6 is blunt that flattening a table into a block of text is an
 * invalid implementation, so the rows do not become nodes. Exactly one node is emitted, and
 * it describes the table: its name, its columns and their types, its row count, and where it
 * came from. That node is what search finds. The rows are reached by SQL, with provenance.
 *
 * The whole file is read into memory rather than streamed, which is a deliberate limit. The
 * port hands a parser `bytes`, so the file is already resident before this runs, and a
 * streaming reader here would halve nothing while adding a second code path. Measured at the
 * envelope on 2026-08-04: a 500,000-row, five-column file (21 MB on disk) parses in 1.7 s and
 * imports in 0.4 s, holding about 360 MB above baseline. That is affordable for a build
 * process and it is the number to check against, not a guess. A format that outgrows it earns
 * a streaming reader and the port change to justify one.
 */
export const csvParser: ArtifactParser = {
  id: CSV_PARSER_ID,
  version: CSV_PARSER_VERSION,

  supports(input) {
    return /\.(csv|tsv)$/i.test(input.relativePath) || input.mediaType === 'text/csv';
  },

  parse(input: ParseInput): ParsedArtifact {
    const warnings: ParserWarning[] = [];
    const text = stripBom(decodeUtf8Strict(input.bytes, input.displayPath));

    const dialect = /\.tsv$/i.test(input.relativePath)
      ? { delimiter: '\t', reason: 'the file extension is .tsv' }
      : detectDelimiter(text);

    const rows = readRows(text, dialect.delimiter, input);
    const table = buildTable(input, rows, dialect, warnings);

    const builder = new NodeBuilder(input);
    const filename = input.relativePath.split('/').at(-1) ?? input.relativePath;
    const title = filename.replace(/\.[^.]+$/, '') || filename;

    const root = builder.add({
      ordinalPath: [0],
      kind: 'document',
      title,
      lineStart: 1,
      lineEnd: Math.max(1, rows.length),
    });

    if (table !== null) {
      // The one node, and the reason there is only one. It is a description a person could
      // have written: "a table of 4 columns and 812 rows, these are the columns". A reader
      // searching for "invoice totals" finds it and then queries; they never receive 812
      // rows of comma-joined prose that no model can aggregate and no locator can cite.
      builder.add({
        ordinalPath: [0, 1],
        kind: 'table',
        parentId: root.id,
        title,
        text: describeTable(table),
        lineStart: 1,
        lineEnd: Math.max(1, rows.length),
        metadata: {
          tableId: table.tableId,
          rowCount: table.rows.length,
          columns: table.columns.map((column) => column.name),
        },
      });
    }

    return {
      artifact: buildArtifact(
        input,
        { id: CSV_PARSER_ID, version: CSV_PARSER_VERSION },
        {
          title,
          metadata: {
            delimiter: dialect.delimiter,
            normalizationVersion: CSV_LIMITS.normalizationVersion,
          },
        },
      ),
      nodes: builder.nodes as LoreNode[],
      warnings,
      ...(table === null ? {} : { tables: [table] }),
    };
  },
};

/** A BOM is an encoding marker, not data, and left in place it becomes part of column one. */
function stripBom(text: string): string {
  return text.startsWith('﻿') ? text.slice(1) : text;
}

/**
 * Reads the grid, as arrays.
 *
 * Arrays rather than `columns: true`, which was a measured decision and not a style choice.
 * Given `a,a` that option returns one column and lets the second silently win, and given a
 * row with an extra cell it discards the cell. Both are exactly the silent drops this ticket
 * forbids. Reading arrays means raggedness is a length this code can see and warn about, with
 * the line number attached.
 */
function readRows(text: string, delimiter: string, input: ParseInput): string[][] {
  try {
    return parseCsv(text, {
      delimiter,
      // A real export contains `5" pipe` in an unquoted field. Failing the whole file over
      // one stray quote helps nobody, and this does not weaken a properly quoted field:
      // verified that `"x,y"` still parses as one field with this on.
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: true,
      // Whitespace is data until a user says otherwise. Trimming would quietly change
      // ` 007 ` into something a different parser reads differently.
      trim: false,
    }) as string[][];
  } catch (cause) {
    throw new LoreError(
      'LORE_E_PARSE_FAILED',
      `${input.displayPath} is not readable as delimited text.`,
      {
        remediation: `Check that the file uses one of the delimiters ${DELIMITERS.map((one) => (one === '\t' ? 'tab' : one)).join(' ')} and that quotes are balanced, or exclude it in .loreignore.`,
        path: input.displayPath,
        cause,
      },
    );
  }
}

function buildTable(
  input: ParseInput,
  rows: readonly (readonly string[])[],
  dialect: { delimiter: string; reason: string },
  warnings: ParserWarning[],
): ParsedTable | null {
  if (rows.length === 0) {
    warnings.push({ code: 'empty-file', message: 'The file has no rows, so no table was made.' });
    return null;
  }

  // The width is the widest row, not the first. A header with four names and a body row with
  // five cells means the file has five columns and the fifth is unnamed, which is recoverable.
  // Taking the first row's width instead would drop that column without saying so.
  //
  // Looped rather than `Math.max(...rows.map(...))`, which is the obvious way to write this
  // and throws `RangeError: Maximum call stack size exceeded` at around a hundred thousand
  // rows, because a spread passes one argument per element. Found by the envelope test, not
  // by any unit test, which is the argument for having one.
  let columnCount = 0;
  for (const row of rows) if (row.length > columnCount) columnCount = row.length;
  assertColumnCount(columnCount, input);

  const header = decideHeader(rows, columnCount);
  warnings.push(...header.warnings);
  const body = header.hasHeader ? rows.slice(1) : rows;

  if (body.length > CSV_LIMITS.maxRows) {
    throw new LoreError(
      'LORE_E_ENVELOPE_EXCEEDED',
      `${input.displayPath} has ${count(body.length, 'row')}, above the supported limit of ${CSV_LIMITS.maxRows.toLocaleString('en-US')}.`,
      {
        remediation:
          'Split the file, or filter it to the rows the project needs. The limit exists because every row is imported into the build and served from it.',
        path: input.displayPath,
      },
    );
  }

  reportRagged(body, columnCount, header.hasHeader, warnings);

  const types = inferColumnTypes(body, columnCount, warnings, header.names);
  const accumulators = types.map(() => new ColumnAccumulator());
  const nullable = types.map(() => false);
  const values: TableValue[][] = [];

  for (const row of body) {
    const converted: TableValue[] = [];
    for (let index = 0; index < columnCount; index += 1) {
      // A short row's missing cells are null, not empty strings. The row was ragged, which
      // has already been warned about; recording absence as absence is the honest reading.
      const raw = row[index];
      const value = raw === undefined ? null : coerce(raw, types[index] as ColumnTypeName);
      if (value === null) nullable[index] = true;
      (accumulators[index] as ColumnAccumulator).add(value);
      converted.push(value);
    }
    values.push(converted);
  }

  const columns: ParsedColumn[] = types.map((type, index) => ({
    name: header.names[index] as string,
    type,
    nullable: nullable[index] as boolean,
    statistics: (accumulators[index] as ColumnAccumulator).result(),
  }));

  const name = (input.relativePath.split('/').at(-1) ?? input.relativePath).replace(/\.[^.]+$/, '');

  return {
    // Derived from the artifact, which is derived from the path, so the same file in the
    // same project is the same table on every machine and across every rebuild.
    tableId: `${input.artifactId}#table`,
    name: name === '' ? input.relativePath : name,
    columns,
    rows: values,
    locator: {
      artifactId: input.artifactId,
      relativePath: input.relativePath,
      lineStart: 1,
      lineEnd: rows.length,
    },
    metadata: {
      delimiter: dialect.delimiter,
      delimiterReason: dialect.reason,
      hasHeader: header.hasHeader,
      headerReason: header.reason,
      // Recorded so the type decision is auditable: a reader who disagrees with a column's
      // type can see how many rows the decision was made from.
      inferenceSampleRows: Math.min(body.length, CSV_LIMITS.inferenceSampleRows),
      normalizationVersion: CSV_LIMITS.normalizationVersion,
    },
  };
}

function assertColumnCount(columnCount: number, input: ParseInput): void {
  if (columnCount <= CSV_LIMITS.maxColumns) return;
  throw new LoreError(
    'LORE_E_ENVELOPE_EXCEEDED',
    `${input.displayPath} has ${count(columnCount, 'column')}, above the supported limit of ${String(CSV_LIMITS.maxColumns)}.`,
    {
      remediation:
        'Split the file into narrower tables. The limit matches Cloudflare D1, so a table that exceeds it here could not be deployed either.',
      path: input.displayPath,
    },
  );
}

/**
 * Rows whose width disagrees with the table's, reported with line numbers.
 *
 * Bounded to the first few, because a file with a systematic off-by-one produces one warning
 * per row and drowns everything else in the build report. The total is stated so the count is
 * never hidden, which is the rule the discovery warnings follow too.
 */
function reportRagged(
  body: readonly (readonly string[])[],
  columnCount: number,
  hasHeader: boolean,
  warnings: ParserWarning[],
): void {
  const offset = hasHeader ? 2 : 1;
  const ragged: number[] = [];
  for (const [index, row] of body.entries()) {
    if (row.length !== columnCount) ragged.push(index + offset);
  }
  if (ragged.length === 0) return;

  const shown = ragged.slice(0, 5);
  const suffix =
    ragged.length > shown.length ? `, and ${count(ragged.length - shown.length, 'other')}` : '';
  warnings.push({
    code: 'csv-ragged-row',
    message: `${count(ragged.length, 'row')} did not have ${String(columnCount)} fields: ${shown.map(String).join(', ')}${suffix}. Missing cells were stored as null and no cell was discarded.`,
    line: shown[0] as number,
  });
}

/**
 * Types from a bounded sample, then verified against every row.
 *
 * The sample is what makes a 500,000-row file affordable to type. The verification pass is
 * what makes it safe: if row 400,000 of a column typed `integer` says `N/A-2`, the column
 * widens to `text` rather than storing a null and losing the value. Widening is announced,
 * because a user who expected to sum that column needs to know why they cannot.
 */
function inferColumnTypes(
  body: readonly (readonly string[])[],
  columnCount: number,
  warnings: ParserWarning[],
  names: readonly string[],
): ColumnTypeName[] {
  const sample = body.slice(0, CSV_LIMITS.inferenceSampleRows);
  const types: ColumnTypeName[] = [];
  for (let index = 0; index < columnCount; index += 1) {
    types.push(inferType(sample.map((row) => row[index] ?? '')));
  }

  const widened: string[] = [];
  for (let index = 0; index < columnCount; index += 1) {
    const type = types[index] as ColumnTypeName;
    if (type === 'text') continue;
    for (let row = sample.length; row < body.length; row += 1) {
      const value = (body[row] as readonly string[])[index] ?? '';
      if (fitsType(value, type)) continue;
      widened.push(`${names[index] as string} (${type} to text)`);
      types[index] = 'text';
      break;
    }
  }

  if (widened.length > 0) {
    warnings.push({
      code: 'csv-type-widened',
      message: `These columns were typed from the first ${count(sample.length, 'row')} and then widened because a later row did not fit: ${widened.sort().join(', ')}. No value was discarded.`,
      line: 1,
    });
  }
  return types;
}

/**
 * The text of the one retrieval node.
 *
 * Written as a sentence rather than a dump, because it is indexed for search and read by a
 * model deciding whether to query. Column names carry most of the signal: someone asking
 * about "shipping cost by region" should match a table that has those columns.
 */
function describeTable(table: ParsedTable): string {
  const columns = table.columns
    .map((column) => `${column.name} (${column.type}${column.nullable ? ', nullable' : ''})`)
    .join(', ');
  const sample = table.rows
    .slice(0, SAMPLE_ROWS)
    .map((row) => row.map((value) => (value === null ? '' : String(value))).join(' | '))
    .join('\n');
  return [
    `Table ${table.name}: ${count(table.rows.length, 'row')}, ${count(table.columns.length, 'column')}.`,
    `Columns: ${columns}.`,
    sample === '' ? '' : `First rows:\n${sample}`,
  ]
    .filter((part) => part !== '')
    .join('\n');
}
