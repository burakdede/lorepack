import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LoreError } from '@lorepack/core';

const MAX_D1_VALUE_BYTES = 2_000_000;
export const D1_FREE_TIER_LIMIT_BYTES = 500_000_000;
export const D1_FREE_TIER_WARN_BYTES = 400_000_000;

interface ChunkRow {
  readonly relative_path: string;
  readonly line_start: number | null;
  readonly line_end: number | null;
  readonly page: number | null;
  readonly text: string;
}

interface TableRow {
  readonly id: string;
  readonly name: string;
  readonly sheet: string | null;
  readonly sql_name: string;
  readonly relative_path: string;
  readonly cell_range: string | null;
}

interface TableColumnRow {
  readonly table_id: string;
  readonly sql_name: string;
}

export interface ProjectionPreflightResult {
  readonly estimatedProjectedBytes: number;
  readonly largestContributors: ReadonlyArray<{
    readonly relativePath: string;
    readonly bytes: number;
  }>;
}

const BUILD_CHUNKS_QUERY = `SELECT relative_path, line_start, line_end, page, text
FROM chunks
ORDER BY id`;

const BUILD_TABLES_QUERY = `SELECT id, name, sheet, sql_name, relative_path, cell_range
FROM tables
ORDER BY id`;

const BUILD_COLUMNS_QUERY = `SELECT table_id, sql_name
FROM table_columns
ORDER BY table_id, ordinal`;

export function preflightProjection(buildDirectory: string): ProjectionPreflightResult {
  const db = openBuildDatabase(buildDirectory);
  try {
    const contributors = new Map<string, number>();

    const chunks = db.prepare(BUILD_CHUNKS_QUERY).all() as unknown as ChunkRow[];
    for (const chunk of chunks) {
      const bytes = byteLength(chunk.text);
      bump(contributors, chunk.relative_path, bytes);
      if (bytes > MAX_D1_VALUE_BYTES) {
        throw new LoreError(
          'LORE_E_LIMIT_EXCEEDED',
          `Chunk text at ${renderChunkLocator(chunk)} is ${bytes.toLocaleString('en-US')} bytes, above Cloudflare D1's 2,000,000-byte value limit.`,
          {
            remediation:
              'Reduce the source content so one indexed chunk stays below Cloudflare D1 storage limits before deploying this build.',
            subject: chunk.relative_path,
            details: {
              locator: {
                relativePath: chunk.relative_path,
                lineStart: chunk.line_start,
                lineEnd: chunk.line_end,
                page: chunk.page,
              },
              bytes,
              limit: MAX_D1_VALUE_BYTES,
            },
          },
        );
      }
    }

    const tables = db.prepare(BUILD_TABLES_QUERY).all() as unknown as TableRow[];
    const columns = db.prepare(BUILD_COLUMNS_QUERY).all() as unknown as TableColumnRow[];
    const columnsByTable = new Map<string, string[]>();
    for (const column of columns) {
      const existing = columnsByTable.get(column.table_id) ?? [];
      existing.push(column.sql_name);
      columnsByTable.set(column.table_id, existing);
    }

    for (const table of tables) {
      const sqlName = assertIdentifier(table.sql_name);
      const selected = (columnsByTable.get(table.id) ?? []).map(assertIdentifier);
      if (selected.length === 0) continue;
      const rows = db.prepare(`SELECT ${selected.join(', ')} FROM ${sqlName}`).all() as Array<
        Record<string, unknown>
      >;
      for (const [index, row] of rows.entries()) {
        const bytes = projectedRowBytes(selected, row);
        bump(contributors, table.relative_path, bytes);
        if (bytes > MAX_D1_VALUE_BYTES) {
          throw new LoreError(
            'LORE_E_LIMIT_EXCEEDED',
            `Table row ${index + 1} in ${table.relative_path}${table.sheet === null ? '' : ` (${table.sheet})`} is ${bytes.toLocaleString('en-US')} bytes, above Cloudflare D1's 2,000,000-byte row limit.`,
            {
              remediation:
                'Reduce the row width or cell sizes in the source table so one projected row stays below Cloudflare D1 storage limits before deploying this build.',
              subject: table.relative_path,
              details: {
                locator: {
                  relativePath: table.relative_path,
                  sheet: table.sheet,
                  cellRange: table.cell_range,
                },
                row: index + 1,
                table: table.name,
                bytes,
                limit: MAX_D1_VALUE_BYTES,
              },
            },
          );
        }
      }
    }

    const largestContributors = [...contributors.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 3)
      .map(([relativePath, bytes]) => ({ relativePath, bytes }));
    return {
      estimatedProjectedBytes: [...contributors.values()].reduce((sum, value) => sum + value, 0),
      largestContributors,
    };
  } finally {
    db.close();
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

function projectedRowBytes(
  columns: readonly string[],
  row: Readonly<Record<string, unknown>>,
): number {
  let bytes = 0;
  for (const column of columns) {
    const value = row[column];
    if (typeof value === 'string') bytes += byteLength(value);
    else if (typeof value === 'number') bytes += byteLength(String(value));
    else if (typeof value === 'bigint') bytes += byteLength(String(value));
    else if (typeof value === 'boolean') bytes += 1;
  }
  return bytes;
}

function renderChunkLocator(chunk: ChunkRow): string {
  if (chunk.page !== null) return `${chunk.relative_path} page ${chunk.page}`;
  if (chunk.line_start !== null && chunk.line_end !== null) {
    return `${chunk.relative_path} lines ${chunk.line_start}-${chunk.line_end}`;
  }
  return chunk.relative_path;
}

function assertIdentifier(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new LoreError('LORE_E_INTERNAL', `Refusing to use ${name} as a SQL identifier.`, {
      remediation:
        'This is a defect in projection planning. Please report the build that triggered it.',
    });
  }
  return name;
}

function bump(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
