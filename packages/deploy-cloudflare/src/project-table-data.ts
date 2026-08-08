import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashBytes, LoreError, type TableValue } from '@lorepack/core';
import type { ProjectionMigrationDatabaseLike } from './projection-migrations.js';

interface BuildTableRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly name: string;
  readonly sheet: string | null;
  readonly sql_name: string;
  readonly row_count: number;
  readonly relative_path: string;
  readonly line_start: number | null;
  readonly line_end: number | null;
  readonly cell_range: string | null;
  readonly metadata: string;
}

interface BuildColumnRow {
  readonly table_id: string;
  readonly ordinal: number;
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

export interface ProjectTableDataOptions {
  readonly db: ProjectionMigrationDatabaseLike;
  readonly projectId: string;
  readonly buildId: string;
  readonly buildDirectory: string;
}

export interface ProjectTableDataResult {
  readonly projectedTables: number;
  readonly projectedRows: number;
}

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

const BUILD_TABLES_QUERY = `SELECT id, artifact_id, name, sheet, sql_name, row_count,
       relative_path, line_start, line_end, cell_range, metadata
FROM tables
ORDER BY id`;

const BUILD_COLUMNS_QUERY = `SELECT table_id, ordinal, name, sql_name, type, nullable,
       null_count, distinct_estimate, distinct_is_exact, min_value, max_value
FROM table_columns
ORDER BY table_id, ordinal`;

const LOOKUP_PROJECTED_SQL_NAMES = `SELECT sql_name
FROM tables
WHERE project_id = ? AND build_id = ?`;

const DELETE_PROJECTED_COLUMNS = 'DELETE FROM table_columns WHERE project_id = ? AND build_id = ?';
const DELETE_PROJECTED_TABLES = 'DELETE FROM tables WHERE project_id = ? AND build_id = ?';

const INSERT_PROJECTED_TABLE = `INSERT INTO tables
  (id, project_id, build_id, artifact_id, name, sheet, sql_name, row_count, relative_path,
   line_start, line_end, cell_range, metadata_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_PROJECTED_COLUMN = `INSERT INTO table_columns
  (project_id, build_id, table_id, ordinal, name, sql_name, type, nullable, null_count,
   distinct_estimate, distinct_is_exact, min_value, max_value)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SQL_TYPES: Record<string, string> = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  boolean: 'INTEGER',
  date: 'TEXT',
  unknown: 'TEXT',
};

export async function projectTableData(
  options: ProjectTableDataOptions,
): Promise<ProjectTableDataResult> {
  const buildDatabase = openBuildDatabase(options.buildDirectory);

  try {
    const tables = buildDatabase.prepare(BUILD_TABLES_QUERY).all() as unknown as BuildTableRow[];
    const columns = buildDatabase.prepare(BUILD_COLUMNS_QUERY).all() as unknown as BuildColumnRow[];
    const columnsByTable = new Map<string, BuildColumnRow[]>();
    for (const column of columns) {
      const existing = columnsByTable.get(column.table_id) ?? [];
      existing.push(column);
      columnsByTable.set(column.table_id, existing);
    }

    await options.db.prepare('BEGIN IMMEDIATE').run();
    try {
      const previous = await options.db
        .prepare(LOOKUP_PROJECTED_SQL_NAMES)
        .bind(options.projectId, options.buildId)
        .run<{ sql_name: string }>();
      for (const row of previous.results ?? []) {
        await options.db.prepare(`DROP TABLE IF EXISTS ${assertIdentifier(row.sql_name)}`).run();
      }
      await options.db
        .prepare(DELETE_PROJECTED_COLUMNS)
        .bind(options.projectId, options.buildId)
        .run();
      await options.db
        .prepare(DELETE_PROJECTED_TABLES)
        .bind(options.projectId, options.buildId)
        .run();

      let projectedRows = 0;
      for (const table of tables) {
        const projectedSqlName = projectedSqlNameFor(options.buildId, table.id, table.sql_name);
        const tableColumns = columnsByTable.get(table.id) ?? [];
        await createPhysicalTable(options.db, projectedSqlName, tableColumns);
        projectedRows += await copyRows(
          buildDatabase,
          options.db,
          table.sql_name,
          projectedSqlName,
          tableColumns,
        );

        await options.db
          .prepare(INSERT_PROJECTED_TABLE)
          .bind(
            table.id,
            options.projectId,
            options.buildId,
            table.artifact_id,
            table.name,
            table.sheet,
            projectedSqlName,
            table.row_count,
            table.relative_path,
            table.line_start,
            table.line_end,
            table.cell_range,
            table.metadata,
          )
          .run();

        for (const column of tableColumns) {
          await options.db
            .prepare(INSERT_PROJECTED_COLUMN)
            .bind(
              options.projectId,
              options.buildId,
              table.id,
              column.ordinal,
              column.name,
              column.sql_name,
              column.type,
              column.nullable,
              column.null_count,
              column.distinct_estimate,
              column.distinct_is_exact,
              column.min_value,
              column.max_value,
            )
            .run();
        }
      }

      await options.db.prepare('COMMIT').run();
      return { projectedTables: tables.length, projectedRows };
    } catch (cause) {
      await options.db.prepare('ROLLBACK').run();
      throw cause;
    }
  } finally {
    buildDatabase.close();
  }
}

function openBuildDatabase(buildDirectory: string): DatabaseSync {
  const path = join(buildDirectory, 'context.sqlite');
  if (!existsSync(path)) {
    throw new LoreError(
      'LORE_E_BUILD_NOT_FOUND',
      `Build ${buildDirectory} has no context.sqlite.`,
      {
        remediation: 'Project only a verified sealed build directory.',
        subject: path,
      },
    );
  }

  try {
    return new DatabaseSync(path, {
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
  } catch (cause) {
    throw new LoreError('LORE_E_SQLITE_UNAVAILABLE', `Cannot open ${path} for reading.`, {
      remediation: 'Check that the sealed build exists and is readable.',
      cause,
    });
  }
}

function projectedSqlNameFor(buildId: string, tableId: string, sourceSqlName: string): string {
  const digest = hashBytes(`${buildId}:${tableId}`).slice(0, 16);
  const prefix = sourceSqlName.slice(0, 45).replace(/[^a-z0-9_]/g, '_');
  return assertIdentifier(`${prefix}_${digest}`);
}

function assertIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new LoreError('LORE_E_INTERNAL', `Refusing to use ${name} as a SQL identifier.`, {
      remediation:
        'This is a defect in table projection. Please report it with the build that triggered it.',
    });
  }
  return name;
}

async function createPhysicalTable(
  db: ProjectionMigrationDatabaseLike,
  sqlName: string,
  columns: readonly BuildColumnRow[],
): Promise<void> {
  const definition = columns
    .map((column) => `${assertIdentifier(column.sql_name)} ${typeOf(column.type)}`)
    .join(', ');
  await db.prepare(`CREATE TABLE ${assertIdentifier(sqlName)} (${definition}) STRICT`).run();
}

async function copyRows(
  buildDatabase: DatabaseSync,
  projection: ProjectionMigrationDatabaseLike,
  sourceSqlName: string,
  targetSqlName: string,
  columns: readonly BuildColumnRow[],
): Promise<number> {
  if (columns.length === 0) return 0;
  const selected = columns.map((column) => assertIdentifier(column.sql_name));
  const rows = buildDatabase
    .prepare(`SELECT ${selected.join(', ')} FROM ${assertIdentifier(sourceSqlName)}`)
    .all() as Array<Record<string, TableValue>>;
  if (rows.length === 0) return 0;

  const tuple = `(${selected.map(() => '?').join(', ')})`;
  const statement = `INSERT INTO ${assertIdentifier(targetSqlName)} (${selected.join(', ')}) VALUES ${rows
    .map(() => tuple)
    .join(', ')}`;
  const values: Array<string | number | null> = [];
  for (const row of rows) {
    for (const column of columns) {
      values.push(toSqlValue(row[column.sql_name] ?? null));
    }
  }
  await projection
    .prepare(statement)
    .bind(...values)
    .run();
  return rows.length;
}

function typeOf(columnType: string): string {
  const sqlType = SQL_TYPES[columnType];
  if (sqlType === undefined) {
    throw new LoreError('LORE_E_INTERNAL', `Unknown table column type ${columnType}.`, {
      remediation:
        'This is a defect in table projection. Please report it with the build that triggered it.',
    });
  }
  return sqlType;
}

function toSqlValue(value: TableValue): string | number | null {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}
