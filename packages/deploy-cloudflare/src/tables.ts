import {
  type ColumnTypeName,
  LoreError,
  type StoredTableDescription,
  type TableQueryRequest,
  type TableQueryResult,
  type TableStore,
} from '@lorepack/core';

/**
 * The remote table projection contract for Phase 6.
 *
 * Table metadata lives in shared D1 catalog tables and is namespaced by `project_id` and
 * `build_id`. Table rows live in build-scoped physical tables whose `sql_name` is opaque to
 * callers and is only reached by first resolving one logical `tableId` through that namespace.
 *
 * This split is what keeps two builds of the same project simultaneously projectable without
 * making model-authored SQL responsible for namespacing. `describeTable()` returns the one
 * physical name the active build owns, and `queryTable()` refuses any statement that tries to
 * read some other table.
 */

interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }>;
}

export interface D1QueryDatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface D1TableNamespace {
  readonly projectId: string;
  readonly buildId: string;
}

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
  readonly cell_range: string | null;
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

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const DESCRIBE_SAMPLE_ROWS = 5;

const LIST_TABLES_QUERY = `SELECT id, name
FROM tables
WHERE project_id = ? AND build_id = ?
ORDER BY name, id`;

const RESOLVE_TABLE_QUERY = `SELECT id, artifact_id, name, sheet, sql_name, row_count,
       relative_path, line_start, line_end, cell_range
FROM tables
WHERE project_id = ? AND build_id = ? AND id = ?
LIMIT 1`;

const TABLE_COLUMNS_QUERY = `SELECT name, sql_name, type, nullable, null_count,
       distinct_estimate, distinct_is_exact, min_value, max_value
FROM table_columns
WHERE project_id = ? AND build_id = ? AND table_id = ?
ORDER BY ordinal`;

export class D1TableStore implements TableStore {
  readonly #db: D1QueryDatabaseLike;
  readonly #namespace: D1TableNamespace;

  constructor(db: D1QueryDatabaseLike, namespace: D1TableNamespace) {
    this.#db = db;
    this.#namespace = namespace;
  }

  async list(): Promise<readonly { readonly tableId: string; readonly name: string }[]> {
    const rows = await this.#run<{ id: string; name: string }>(LIST_TABLES_QUERY, [
      this.#namespace.projectId,
      this.#namespace.buildId,
    ]);
    return rows.map((row) => ({ tableId: row.id, name: row.name }));
  }

  async describe(tableId: string): Promise<StoredTableDescription | null> {
    const resolved = await this.#resolve(tableId);
    if (resolved === null) return null;

    const selected = resolved.columns.map((column) => assertIdentifier(column.sql_name));
    const sample =
      selected.length === 0
        ? []
        : await this.#run<Record<string, unknown>>(
            `SELECT ${selected.join(', ')} FROM ${assertIdentifier(resolved.table.sql_name)} LIMIT ?`,
            [DESCRIBE_SAMPLE_ROWS],
          );

    return {
      tableId: resolved.table.id,
      name: resolved.table.name,
      sqlName: resolved.table.sql_name,
      ...(resolved.table.sheet === null ? {} : { sheet: resolved.table.sheet }),
      columns: resolved.columns.map((column) => ({
        name: column.name,
        sqlName: column.sql_name,
        type: column.type as ColumnTypeName,
        nullable: column.nullable === 1,
        statistics: statisticsOf(column),
      })),
      rowCount: resolved.table.row_count,
      sample: sample.map((row) => relabelRow(row, resolved.columns)),
      locator: tableLocator(resolved.table),
    };
  }

  async query(request: TableQueryRequest): Promise<TableQueryResult> {
    const resolved = await this.#resolve(request.tableId);
    if (resolved === null) {
      throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No table ${request.tableId} in this build.`, {
        remediation: 'Run `lore inspect tables` to see which tables this build contains.',
        subject: request.tableId,
      });
    }

    assertQueryTargetsOnly(request.sql, resolved.table.sql_name);
    const rows = await this.#run<Record<string, unknown>>(request.sql);
    const limited = request.limit === undefined ? rows : rows.slice(0, request.limit);
    const columns =
      limited.length === 0
        ? []
        : Object.keys(limited[0] ?? {}).map(
            (name) => resolved.columns.find((column) => column.sql_name === name)?.name ?? name,
          );

    return {
      columns,
      rows: limited.map((row) => relabelRow(row, resolved.columns)),
      rowCount: limited.length,
      truncated: limited.length < rows.length,
      locator: tableLocator(resolved.table),
    } as TableQueryResult;
  }

  async #resolve(
    tableId: string,
  ): Promise<{ readonly table: TableRow; readonly columns: readonly ColumnRow[] } | null> {
    const table = (
      await this.#run<TableRow>(RESOLVE_TABLE_QUERY, [
        this.#namespace.projectId,
        this.#namespace.buildId,
        tableId,
      ])
    )[0];
    if (table === undefined) return null;

    const columns = await this.#run<ColumnRow>(TABLE_COLUMNS_QUERY, [
      this.#namespace.projectId,
      this.#namespace.buildId,
      tableId,
    ]);
    return { table, columns };
  }

  async #run<T>(query: string, bindings: readonly unknown[] = []): Promise<readonly T[]> {
    const result = await this.#db
      .prepare(query)
      .bind(...bindings)
      .run<T>();
    return result.results ?? [];
  }
}

function assertIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new LoreError('LORE_E_INTERNAL', `Refusing to use ${name} as a SQL identifier.`, {
      remediation:
        'This is a defect in table-name generation, not something a project can cause. Please report it.',
    });
  }
  return name;
}

function tableLocator(table: TableRow): StoredTableDescription['locator'] {
  return {
    artifactId: table.artifact_id,
    relativePath: table.relative_path,
    ...(table.sheet === null ? {} : { sheet: table.sheet }),
    ...(table.cell_range === null ? {} : { cellRange: table.cell_range }),
    ...(table.line_start === null ? {} : { lineStart: table.line_start }),
    ...(table.line_end === null ? {} : { lineEnd: table.line_end }),
  };
}

function decodeValue(value: unknown, type: ColumnTypeName): unknown {
  if (value === null || value === undefined) return null;
  if (type === 'boolean') return value !== 0;
  return value;
}

function decodeBound(raw: string | null, type: ColumnTypeName): string | number | boolean | null {
  if (raw === null) return null;
  if (type === 'boolean') return raw === 'true' || raw === '1';
  if (type === 'integer' || type === 'real') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

function statisticsOf(column: ColumnRow): StoredTableDescription['columns'][number]['statistics'] {
  const type = column.type as ColumnTypeName;
  const min = decodeBound(column.min_value, type);
  const max = decodeBound(column.max_value, type);
  return {
    nullCount: column.null_count,
    distinctEstimate: column.distinct_estimate,
    distinctIsExact: column.distinct_is_exact === 1,
    ...(min === null ? {} : { min }),
    ...(max === null ? {} : { max }),
  };
}

function relabelRow(
  row: Record<string, unknown>,
  columns: readonly ColumnRow[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const column = columns.find((candidate) => candidate.sql_name === key);
    out[column?.name ?? key] =
      column === undefined ? value : decodeValue(value, column.type as ColumnTypeName);
  }
  return out;
}

function assertQueryTargetsOnly(sql: string, allowedTable: string): void {
  const trimmed = sql.trim();
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new LoreError('LORE_E_SQL_REJECTED', 'Only read-only SELECT statements are allowed.', {
      remediation: 'Use a single SELECT that reads the table described by `describeTable`.',
    });
  }

  const matches = Array.from(
    trimmed.matchAll(/\b(?:from|join)\s+([`"]?[a-z][a-z0-9_]{0,62}[`"]?)/gi),
  );
  if (matches.length === 0) {
    throw new LoreError(
      'LORE_E_SQL_REJECTED',
      'The query does not name a table this build exposes.',
      {
        remediation:
          'Call `describeTable` and use the `sqlName` it reports in the query `FROM` clause.',
      },
    );
  }

  for (const match of matches) {
    const referenced = match[1]?.replace(/^[`"]|[`"]$/g, '') ?? '';
    if (referenced !== allowedTable) {
      throw new LoreError(
        'LORE_E_SQL_REJECTED',
        'The query touches something outside the table it was asked about.',
        {
          remediation:
            'A Worker table query may read only the build-scoped physical table that `describeTable` returned for this `tableId`.',
        },
      );
    }
  }
}
