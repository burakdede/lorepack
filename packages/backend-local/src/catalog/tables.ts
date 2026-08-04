import type { DatabaseSync } from 'node:sqlite';
import {
  type ColumnTypeName,
  hashBytes,
  LoreError,
  type ParsedTable,
  type StoredTableDescription,
  type TableValue,
} from '@lorepack/core';

/**
 * Typed tables in a sealed build: the catalog, the physical tables, and the import.
 *
 * The rule the whole file is built around: **no identifier from user content ever reaches
 * SQL**. A spreadsheet can have a sheet called `"; DROP TABLE artifacts; --`, and a column
 * called the same. Every physical name here is generated from a hash, validated against a
 * strict pattern, and asserted immediately before use, so the injection path does not exist
 * rather than being escaped away.
 */

/** Physical tables and their columns. Anything that fails this never reaches a statement. */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Bound values per INSERT batch, counted in cells rather than rows.
 *
 * Rows would be the natural unit and it is the wrong one: a batch of 500 rows is 1,000 bound
 * values in a two-column table and 50,000 in a hundred-column one, and the second is close
 * enough to the argument-spread limit to fail on someone's real spreadsheet. Counting cells
 * makes the statement the same size whatever the table's shape, which is what a bound
 * actually means. SQLite's own default variable limit is 32,766, so this sits below it.
 */
const BATCH_CELLS = 20_000;

/**
 * The prefix every generated table carries.
 *
 * Namespacing is not decoration. Without it a user table called `artifacts` would collide
 * with the catalog's own, and the failure would be at import time on someone's real project.
 */
export const TABLE_PREFIX = 't_';
const COLUMN_PREFIX = 'c_';

/**
 * A deterministic, collision-free physical name.
 *
 * The readable part is for a human reading `.lorepack` internals or an EXPLAIN; the hash is
 * what actually guarantees uniqueness. Derived from the *table id*, which is derived from the
 * artifact path, so the same file produces the same SQL name on Windows and Linux and across
 * rebuilds. That determinism is load-bearing: table names end up in the build database, and a
 * name that varied by machine would make identical projects produce different bytes.
 */
export function sqlNameFor(tableId: string, displayName: string): string {
  const slug = slugify(displayName).slice(0, 40);
  const digest = hashBytes(tableId).slice(0, 12);
  const name = slug === '' ? `${TABLE_PREFIX}${digest}` : `${TABLE_PREFIX}${slug}_${digest}`;
  return assertIdentifier(name);
}

function columnSqlName(ordinal: number, name: string): string {
  const slug = slugify(name).slice(0, 40);
  const suffix = String(ordinal);
  return assertIdentifier(
    slug === '' ? `${COLUMN_PREFIX}${suffix}` : `${COLUMN_PREFIX}${suffix}_${slug}`,
  );
}

/**
 * Reduces a name to the identifier alphabet.
 *
 * Lossy on purpose. Two different sheet names can slug to the same thing, and that is fine
 * because the slug is never the identity: the hash is. What matters is that the output
 * contains nothing but `[a-z0-9_]`, whatever went in, including a name written entirely in
 * Japanese or consisting of a single quote character.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The last line of defence, called on every identifier immediately before interpolation.
 *
 * It should be impossible to fail: everything reaching it has been through `slugify`. That
 * is exactly why it is here. An assertion that can only fire if an earlier invariant broke is
 * the one worth keeping, because the day someone adds a second name generator and forgets to
 * slug it, this throws instead of executing whatever they passed.
 */
export function assertIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new LoreError('LORE_E_INTERNAL', `Refusing to use ${name} as a SQL identifier.`, {
      remediation:
        'This is a defect in table-name generation, not something a project can cause. Please report it with the file that triggered it.',
    });
  }
  return name;
}

const SQL_TYPES: Record<ColumnTypeName, string> = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  boolean: 'INTEGER',
  // Stored as ISO text: SQLite has no date type and neither does D1, and an epoch integer
  // would need a timezone the source never stated.
  date: 'TEXT',
  unknown: 'TEXT',
};

export interface WriteTablesResult {
  readonly tables: number;
  readonly rows: number;
}

/**
 * Creates and fills every physical table, inside the caller's transaction.
 *
 * Deliberately not opening its own transaction: `writeCatalog` already wraps the whole build
 * in one, and a build database is complete or discarded. A failure here therefore rolls the
 * *entire* build back, which is what #76 asks for when it says a mid-import failure must not
 * leave a half-imported table behind.
 */
export function writeTables(db: DatabaseSync, tables: readonly ParsedTable[]): WriteTablesResult {
  const insertTable = db.prepare(
    `INSERT INTO tables
       (id, artifact_id, name, sheet, sql_name, row_count, relative_path, line_start, line_end, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertColumn = db.prepare(
    `INSERT INTO table_columns
       (table_id, ordinal, name, sql_name, type, nullable, null_count, distinct_estimate,
        distinct_is_exact, min_value, max_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let rowTotal = 0;
  for (const table of tables) {
    const sqlName = sqlNameFor(table.tableId, table.sheet ?? table.name);
    const columnNames = table.columns.map((column, ordinal) => columnSqlName(ordinal, column.name));

    const definition = table.columns
      .map((column, index) => `${columnNames[index] as string} ${SQL_TYPES[column.type]}`)
      .join(', ');
    // Every name in this statement came from `assertIdentifier`. Values never appear in DDL.
    db.exec(`CREATE TABLE ${sqlName} (${definition}) STRICT`);

    insertTable.run(
      table.tableId,
      table.locator.artifactId,
      table.name,
      table.sheet ?? null,
      sqlName,
      table.rows.length,
      table.locator.relativePath,
      table.locator.lineStart ?? null,
      table.locator.lineEnd ?? null,
      JSON.stringify(table.metadata),
    );

    for (const [ordinal, column] of table.columns.entries()) {
      insertColumn.run(
        table.tableId,
        ordinal,
        column.name,
        columnNames[ordinal] as string,
        column.type,
        column.nullable ? 1 : 0,
        column.statistics.nullCount,
        column.statistics.distinctEstimate,
        column.statistics.distinctIsExact ? 1 : 0,
        column.statistics.min === undefined ? null : String(column.statistics.min),
        column.statistics.max === undefined ? null : String(column.statistics.max),
      );
    }

    rowTotal += insertRows(db, sqlName, columnNames, table);
  }

  return { tables: tables.length, rows: rowTotal };
}

/**
 * Batched multi-row inserts.
 *
 * One statement per row at 500,000 rows spends most of the import in statement dispatch. One
 * statement for all of them exceeds SQLite's variable limit. Batching at a fixed size gives a
 * bounded statement and one prepare per batch shape, of which there are at most two: the full
 * batch, and the remainder.
 */
function insertRows(
  db: DatabaseSync,
  sqlName: string,
  columnNames: readonly string[],
  table: ParsedTable,
): number {
  if (table.rows.length === 0 || columnNames.length === 0) return 0;

  const columnList = columnNames.join(', ');
  const tuple = `(${columnNames.map(() => '?').join(', ')})`;
  const statementFor = (rows: number): ReturnType<DatabaseSync['prepare']> =>
    db.prepare(
      `INSERT INTO ${sqlName} (${columnList}) VALUES ${Array.from({ length: rows }, () => tuple).join(', ')}`,
    );

  const batchRows = Math.max(1, Math.floor(BATCH_CELLS / columnNames.length));
  const full = table.rows.length >= batchRows ? statementFor(batchRows) : null;
  let written = 0;

  for (let start = 0; start < table.rows.length; start += batchRows) {
    const batch = table.rows.slice(start, start + batchRows);
    const statement =
      batch.length === batchRows && full !== null ? full : statementFor(batch.length);
    const values: (string | number | null)[] = [];
    for (const row of batch) {
      for (let index = 0; index < columnNames.length; index += 1) {
        values.push(toSqlite(row[index] ?? null));
      }
    }
    statement.run(...values);
    written += batch.length;
  }
  return written;
}

/** `node:sqlite` binds strings, numbers, bigints, buffers and null. A boolean is not one. */
function toSqlite(value: TableValue): string | number | null {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/** Every physical table in a build, for the read-only authorizer to permit. */
export function physicalTableNames(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT sql_name FROM tables ORDER BY sql_name').all() as {
    sql_name: string;
  }[];
  // Validated on the way out as well as on the way in. These names are read from a database
  // file that arrived over the network in Phase 6, so trusting what was written is not the
  // same as trusting what is read.
  return rows.map((row) => assertIdentifier(row.sql_name));
}

/** The catalog tables a runtime reads to answer `listTables` and `describeTable`. */
export const TABLE_CATALOG_TABLES: readonly string[] = ['tables', 'table_columns'];

interface TableRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly name: string;
  readonly sheet: string | null;
  readonly sql_name: string;
  readonly row_count: number;
  readonly relative_path: string;
  readonly line_start: number | null;
  readonly line_end: number | null;
}

interface ColumnRow {
  readonly name: string;
  readonly sql_name: string;
  readonly type: string;
  readonly nullable: number;
  readonly null_count: number;
  readonly distinct_estimate: number;
  readonly distinct_is_exact: number;
  readonly min_value: string | null;
  readonly max_value: string | null;
}

export function listTableRows(db: DatabaseSync): { tableId: string; name: string }[] {
  const rows = db.prepare('SELECT id, name FROM tables ORDER BY name, id').all() as {
    id: string;
    name: string;
  }[];
  return rows.map((row) => ({ tableId: row.id, name: row.name }));
}

/** The physical name and column layout for one table id, or null if there is no such table. */
export function resolveTable(
  db: DatabaseSync,
  tableId: string,
): { table: TableRow; columns: ColumnRow[] } | null {
  const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(tableId) as unknown as
    | TableRow
    | undefined;
  if (table === undefined) return null;
  const columns = db
    .prepare('SELECT * FROM table_columns WHERE table_id = ? ORDER BY ordinal')
    .all(tableId) as unknown as ColumnRow[];
  return { table, columns };
}

/**
 * `describeTable`, including the example rows.
 *
 * The sample is read through the *generated* column names and relabelled to the source names
 * on the way out, so a caller sees `Postal Code` while the query used `c_2_postal_code`.
 */
export function describeStoredTable(
  db: DatabaseSync,
  tableId: string,
  sampleRows: number,
): StoredTableDescription | null {
  const resolved = resolveTable(db, tableId);
  if (resolved === null) return null;
  const { table, columns } = resolved;

  const selected = columns.map((column) => assertIdentifier(column.sql_name));
  const sample =
    selected.length === 0
      ? []
      : (db
          .prepare(`SELECT ${selected.join(', ')} FROM ${assertIdentifier(table.sql_name)} LIMIT ?`)
          .all(sampleRows) as Record<string, unknown>[]);

  return {
    tableId: table.id,
    name: table.name,
    ...(table.sheet === null ? {} : { sheet: table.sheet }),
    columns: columns.map((column) => ({
      name: column.name,
      type: column.type as ColumnTypeName,
      nullable: column.nullable === 1,
    })),
    rowCount: table.row_count,
    sample: sample.map((row) => relabel(row, columns)),
    locator: {
      artifactId: table.artifact_id,
      relativePath: table.relative_path,
      ...(table.line_start === null ? {} : { lineStart: table.line_start }),
      ...(table.line_end === null ? {} : { lineEnd: table.line_end }),
    },
  };
}

function relabel(
  row: Record<string, unknown>,
  columns: readonly ColumnRow[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) out[column.name] = row[column.sql_name] ?? null;
  return out;
}
