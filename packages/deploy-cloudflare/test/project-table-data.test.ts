import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BuildManifest } from '@lorepack/core';
import { afterEach, describe, expect, it } from 'vitest';
import { projectTableData } from '../src/project-table-data.js';
import {
  type ProjectionMigrationDatabaseLike,
  type ProjectionMigrationStatementLike,
  runProjectionMigrations,
} from '../src/projection-migrations.js';
import { type D1QueryDatabaseLike, D1TableStore } from '../src/tables.js';

const PROJECT = 'demo';
const BUILD_A = `lore_${'a'.repeat(64)}`;
const BUILD_B = `lore_${'b'.repeat(64)}`;
const TABLE_ID = 'demo:pricing.xlsx#Products';

const MANIFEST_A: BuildManifest = {
  formatVersion: 1,
  buildId: BUILD_A,
  projectName: PROJECT,
  compilerVersion: '0.1.0',
  schemaVersion: 1,
  configurationHash: 'c'.repeat(64),
  sourceFingerprint: 'd'.repeat(64),
  canonicalRoots: {
    artifacts: '1'.repeat(64),
    nodes: '2'.repeat(64),
    chunks: '3'.repeat(64),
    tables: '4'.repeat(64),
    objects: '5'.repeat(64),
  },
  capabilities: ['lexical-search', 'structured-context', 'table-query'],
  counts: { artifacts: 1, nodes: 0, chunks: 0, tables: 1, tableRows: 3 },
  warnings: [],
};

const MANIFEST_B: BuildManifest = {
  ...MANIFEST_A,
  buildId: BUILD_B,
  counts: { artifacts: 1, nodes: 0, chunks: 0, tables: 1, tableRows: 2 },
};

class SqliteStatement
  implements ProjectionMigrationStatementLike, ReturnType<D1QueryDatabaseLike['prepare']>
{
  readonly #db: DatabaseSync;
  readonly #query: string;
  #bindings: readonly unknown[] = [];

  constructor(db: DatabaseSync, query: string) {
    this.#db = db;
    this.#query = query;
  }

  bind(...values: unknown[]): SqliteStatement {
    this.#bindings = values;
    return this;
  }

  async run<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }> {
    const statement = this.#db.prepare(this.#query);
    const trimmed = this.#query.trim().toLowerCase();
    if (trimmed.startsWith('select') || trimmed.startsWith('pragma')) {
      return { results: statement.all(...this.#bindings) as readonly T[] };
    }
    statement.run(...this.#bindings);
    return {};
  }
}

class SqliteProjectionDatabase implements ProjectionMigrationDatabaseLike, D1QueryDatabaseLike {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this.#db, query);
  }
}

const directories: string[] = [];
const databases: DatabaseSync[] = [];

function makeBuildDirectory(buildId: string, rowCount: number): string {
  const directory = mkdtempSync(join(tmpdir(), 'lore-build-'));
  directories.push(directory);
  mkdirSync(join(directory, 'reports'));
  const manifest = buildId === BUILD_A ? MANIFEST_A : MANIFEST_B;
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, 'reports', 'warnings.json'), '[]\n');

  const db = new DatabaseSync(join(directory, 'context.sqlite'), {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  databases.push(db);
  db.exec(`CREATE TABLE tables (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sheet TEXT,
    sql_name TEXT NOT NULL UNIQUE,
    row_count INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER,
    cell_range TEXT,
    metadata TEXT NOT NULL
  ) STRICT`);
  db.exec(`CREATE TABLE table_columns (
    table_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    sql_name TEXT NOT NULL,
    type TEXT NOT NULL,
    nullable INTEGER NOT NULL,
    null_count INTEGER NOT NULL,
    distinct_estimate INTEGER NOT NULL,
    distinct_is_exact INTEGER NOT NULL,
    min_value TEXT,
    max_value TEXT,
    PRIMARY KEY (table_id, ordinal)
  ) STRICT`);
  db.exec(`CREATE TABLE t_products (
    c_0_sku TEXT,
    c_1_price REAL,
    c_2_available INTEGER
  ) STRICT`);

  db.prepare(
    `INSERT INTO tables
      (id, artifact_id, name, sheet, sql_name, row_count, relative_path, line_start, line_end, cell_range, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TABLE_ID,
    'demo:pricing.xlsx',
    'Products',
    'Products',
    't_products',
    rowCount,
    'pricing.xlsx',
    null,
    null,
    'A1:C4',
    '{}',
  );
  db.prepare(
    `INSERT INTO table_columns
      (table_id, ordinal, name, sql_name, type, nullable, null_count, distinct_estimate, distinct_is_exact, min_value, max_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TABLE_ID,
    0,
    'SKU',
    'c_0_sku',
    'text',
    0,
    0,
    rowCount,
    1,
    'A-1',
    rowCount === 3 ? 'A-3' : 'A-2',
  );
  db.prepare(
    `INSERT INTO table_columns
      (table_id, ordinal, name, sql_name, type, nullable, null_count, distinct_estimate, distinct_is_exact, min_value, max_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TABLE_ID,
    1,
    'Price',
    'c_1_price',
    'real',
    1,
    rowCount === 3 ? 1 : 0,
    rowCount,
    1,
    '4.5',
    '19.99',
  );
  db.prepare(
    `INSERT INTO table_columns
      (table_id, ordinal, name, sql_name, type, nullable, null_count, distinct_estimate, distinct_is_exact, min_value, max_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(TABLE_ID, 2, 'Available', 'c_2_available', 'boolean', 0, 0, 2, 1, 'false', 'true');

  const baseRows =
    rowCount === 3
      ? [
          ['A-1', 19.99, 1],
          ['A-2', 4.5, 1],
          ['A-3', null, 0],
        ]
      : [
          ['A-1', 19.99, 1],
          ['A-2', 4.5, 0],
        ];
  for (const row of baseRows) {
    db.prepare('INSERT INTO t_products (c_0_sku, c_1_price, c_2_available) VALUES (?, ?, ?)').run(
      row[0],
      row[1],
      row[2],
    );
  }

  db.close();
  databases.pop();
  return directory;
}

afterEach(() => {
  while (databases.length > 0) {
    try {
      databases.pop()?.close();
    } catch {}
  }
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

describe('projectTableData, issue 258', () => {
  it('projects table metadata and rows under build-scoped physical table names', async () => {
    const buildDirectory = makeBuildDirectory(BUILD_A, 3);
    const projection = new DatabaseSync(':memory:');
    databases.push(projection);
    const db = new SqliteProjectionDatabase(projection);
    await runProjectionMigrations(db, () => '2026-08-08T12:00:00.000Z');

    const result = await projectTableData({
      db,
      projectId: PROJECT,
      buildId: BUILD_A,
      buildDirectory,
    });
    expect(result).toEqual({ projectedTables: 1, projectedRows: 3 });

    const store = new D1TableStore(db, { projectId: PROJECT, buildId: BUILD_A });
    const described = await store.describe(TABLE_ID);
    expect(described?.sqlName).toMatch(/^t_products_[0-9a-f]{16}$/);
    expect(described).toMatchObject({
      tableId: TABLE_ID,
      name: 'Products',
      sheet: 'Products',
      rowCount: 3,
      locator: {
        artifactId: 'demo:pricing.xlsx',
        relativePath: 'pricing.xlsx',
        sheet: 'Products',
        cellRange: 'A1:C4',
      },
      sample: [
        { SKU: 'A-1', Price: 19.99, Available: true },
        { SKU: 'A-2', Price: 4.5, Available: true },
        { SKU: 'A-3', Price: null, Available: false },
      ],
    });
    expect(
      await store.query({
        tableId: TABLE_ID,
        sql: `SELECT c_0_sku, c_1_price, c_2_available FROM ${described?.sqlName}`,
      }),
    ).toEqual({
      columns: ['SKU', 'Price', 'Available'],
      rows: [
        { SKU: 'A-1', Price: 19.99, Available: true },
        { SKU: 'A-2', Price: 4.5, Available: true },
        { SKU: 'A-3', Price: null, Available: false },
      ],
      rowCount: 3,
      truncated: false,
      locator: {
        artifactId: 'demo:pricing.xlsx',
        relativePath: 'pricing.xlsx',
        sheet: 'Products',
        cellRange: 'A1:C4',
      },
    });
  });

  it('keeps two projected builds mechanically queryable without sharing physical tables', async () => {
    const buildA = makeBuildDirectory(BUILD_A, 3);
    const buildB = makeBuildDirectory(BUILD_B, 2);
    const projection = new DatabaseSync(':memory:');
    databases.push(projection);
    const db = new SqliteProjectionDatabase(projection);
    await runProjectionMigrations(db, () => '2026-08-08T12:00:00.000Z');

    await projectTableData({ db, projectId: PROJECT, buildId: BUILD_A, buildDirectory: buildA });
    await projectTableData({ db, projectId: PROJECT, buildId: BUILD_B, buildDirectory: buildB });

    const active = await new D1TableStore(db, { projectId: PROJECT, buildId: BUILD_A }).describe(
      TABLE_ID,
    );
    const candidate = await new D1TableStore(db, { projectId: PROJECT, buildId: BUILD_B }).describe(
      TABLE_ID,
    );

    expect(active?.sqlName).not.toBe(candidate?.sqlName);
    expect(active?.sample).toHaveLength(3);
    expect(candidate?.sample).toHaveLength(2);

    await expect(
      new D1TableStore(db, { projectId: PROJECT, buildId: BUILD_A }).query({
        tableId: TABLE_ID,
        sql: `SELECT c_0_sku FROM ${candidate?.sqlName}`,
      }),
    ).rejects.toMatchObject({
      code: 'LORE_E_SQL_REJECTED',
    });
  });
});
