import type { LoreError } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import { type D1QueryDatabaseLike, type D1TableNamespace, D1TableStore } from '../src/tables.js';

const PROJECT = 'demo';
const ACTIVE_BUILD = `lore_${'a'.repeat(64)}`;
const TABLE_ID = 'demo:pricing.xlsx#Products';

class FakePreparedStatement {
  readonly #db: FakeD1Database;
  readonly #query: string;
  readonly #bindings: readonly unknown[];

  constructor(db: FakeD1Database, query: string, bindings: readonly unknown[] = []) {
    this.#db = db;
    this.#query = query;
    this.#bindings = bindings;
  }

  bind(...values: unknown[]): FakePreparedStatement {
    return new FakePreparedStatement(this.#db, this.#query, values);
  }

  async run<T>(): Promise<{ readonly results?: readonly T[] }> {
    this.#db.calls.push({ query: this.#query, bindings: [...this.#bindings] });
    return {
      results: (this.#db.handlers.get(this.#query)?.(this.#bindings) ?? []) as readonly T[],
    };
  }
}

class FakeD1Database implements D1QueryDatabaseLike {
  readonly calls: Array<{ query: string; bindings: unknown[] }> = [];
  readonly handlers = new Map<string, (bindings: readonly unknown[]) => readonly unknown[]>();

  prepare(query: string): FakePreparedStatement {
    return new FakePreparedStatement(this, query);
  }
}

function namespace(buildId: string = ACTIVE_BUILD): D1TableNamespace {
  return { projectId: PROJECT, buildId };
}

function installTableHandlers(db: FakeD1Database): void {
  db.handlers.set(
    `SELECT id, name
FROM tables
WHERE project_id = ? AND build_id = ?
ORDER BY name, id`,
    ([projectId, buildId]) =>
      projectId === PROJECT && buildId === ACTIVE_BUILD
        ? [{ id: TABLE_ID, name: 'Products' }]
        : [{ id: TABLE_ID, name: 'Candidate Products' }],
  );

  db.handlers.set(
    `SELECT id, artifact_id, name, sheet, sql_name, row_count,
       relative_path, line_start, line_end, cell_range
FROM tables
WHERE project_id = ? AND build_id = ? AND id = ?
LIMIT 1`,
    ([projectId, buildId, tableId]) => {
      if (projectId !== PROJECT || tableId !== TABLE_ID) return [];
      if (buildId === ACTIVE_BUILD) {
        return [
          {
            id: TABLE_ID,
            artifact_id: 'demo:pricing.xlsx',
            name: 'Products',
            sheet: 'Products',
            sql_name: 't_products_active',
            row_count: 3,
            relative_path: 'pricing.xlsx',
            line_start: null,
            line_end: null,
            cell_range: 'A1:C4',
          },
        ];
      }
      return [
        {
          id: TABLE_ID,
          artifact_id: 'demo:pricing.xlsx',
          name: 'Products',
          sheet: 'Products',
          sql_name: 't_products_candidate',
          row_count: 2,
          relative_path: 'pricing.xlsx',
          line_start: null,
          line_end: null,
          cell_range: 'A1:C3',
        },
      ];
    },
  );

  db.handlers.set(
    `SELECT name, sql_name, type, nullable, null_count,
       distinct_estimate, distinct_is_exact, min_value, max_value
FROM table_columns
WHERE project_id = ? AND build_id = ? AND table_id = ?
ORDER BY ordinal`,
    ([projectId, buildId, tableId]) =>
      projectId === PROJECT && tableId === TABLE_ID
        ? [
            {
              name: 'SKU',
              sql_name: 'c_0_sku',
              type: 'text',
              nullable: 0,
              null_count: 0,
              distinct_estimate: buildId === ACTIVE_BUILD ? 3 : 2,
              distinct_is_exact: 1,
              min_value: 'A-1',
              max_value: buildId === ACTIVE_BUILD ? 'A-3' : 'A-2',
            },
            {
              name: 'Available',
              sql_name: 'c_1_available',
              type: 'boolean',
              nullable: 0,
              null_count: 0,
              distinct_estimate: 2,
              distinct_is_exact: 1,
              min_value: 'false',
              max_value: 'true',
            },
          ]
        : [],
  );

  db.handlers.set('SELECT c_0_sku, c_1_available FROM t_products_active LIMIT ?', ([limit]) =>
    [
      { c_0_sku: 'A-1', c_1_available: 1 },
      { c_0_sku: 'A-2', c_1_available: 0 },
      { c_0_sku: 'A-3', c_1_available: 1 },
    ].slice(0, Number(limit)),
  );

  db.handlers.set('SELECT c_0_sku, c_1_available FROM t_products_active', () => [
    { c_0_sku: 'A-1', c_1_available: 1 },
    { c_0_sku: 'A-2', c_1_available: 0 },
    { c_0_sku: 'A-3', c_1_available: 1 },
  ]);
}

describe('D1TableStore', () => {
  it('lists tables through project and build namespace filters', async () => {
    const db = new FakeD1Database();
    installTableHandlers(db);

    const listed = await new D1TableStore(db, namespace()).list();

    expect(listed).toEqual([{ tableId: TABLE_ID, name: 'Products' }]);
    expect(db.calls[0]).toEqual({
      query: `SELECT id, name
FROM tables
WHERE project_id = ? AND build_id = ?
ORDER BY name, id`,
      bindings: [PROJECT, ACTIVE_BUILD],
    });
  });

  it('describes typed columns and sample rows for the active namespace only', async () => {
    const db = new FakeD1Database();
    installTableHandlers(db);

    const described = await new D1TableStore(db, namespace()).describe(TABLE_ID);

    expect(described).toEqual({
      tableId: TABLE_ID,
      name: 'Products',
      sqlName: 't_products_active',
      sheet: 'Products',
      columns: [
        {
          name: 'SKU',
          sqlName: 'c_0_sku',
          type: 'text',
          nullable: false,
          statistics: {
            nullCount: 0,
            distinctEstimate: 3,
            distinctIsExact: true,
            min: 'A-1',
            max: 'A-3',
          },
        },
        {
          name: 'Available',
          sqlName: 'c_1_available',
          type: 'boolean',
          nullable: false,
          statistics: {
            nullCount: 0,
            distinctEstimate: 2,
            distinctIsExact: true,
            min: false,
            max: true,
          },
        },
      ],
      rowCount: 3,
      sample: [
        { SKU: 'A-1', Available: true },
        { SKU: 'A-2', Available: false },
        { SKU: 'A-3', Available: true },
      ],
      locator: {
        artifactId: 'demo:pricing.xlsx',
        relativePath: 'pricing.xlsx',
        sheet: 'Products',
        cellRange: 'A1:C4',
      },
    });
    expect(db.calls[0]?.bindings).toEqual([PROJECT, ACTIVE_BUILD, TABLE_ID]);
    expect(db.calls[1]?.bindings).toEqual([PROJECT, ACTIVE_BUILD, TABLE_ID]);
  });

  it('rejects a query that tries to reach another build-scoped physical table', async () => {
    const db = new FakeD1Database();
    installTableHandlers(db);
    const store = new D1TableStore(db, namespace());

    try {
      await store.query({
        tableId: TABLE_ID,
        sql: 'SELECT c_0_sku FROM t_products_candidate',
      });
      expect.unreachable('should have rejected the query');
    } catch (error) {
      expect((error as LoreError).code).toBe('LORE_E_SQL_REJECTED');
      expect((error as LoreError).message).toContain('outside the table');
    }
  });

  it('returns relabelled rows for the resolved physical table and truncates client-side', async () => {
    const db = new FakeD1Database();
    installTableHandlers(db);

    const result = await new D1TableStore(db, namespace()).query({
      tableId: TABLE_ID,
      sql: 'SELECT c_0_sku, c_1_available FROM t_products_active',
      limit: 2,
    });

    expect(result).toEqual({
      columns: ['SKU', 'Available'],
      rows: [
        { SKU: 'A-1', Available: true },
        { SKU: 'A-2', Available: false },
      ],
      rowCount: 2,
      truncated: true,
      locator: {
        artifactId: 'demo:pricing.xlsx',
        relativePath: 'pricing.xlsx',
        sheet: 'Products',
        cellRange: 'A1:C4',
      },
    });
    expect(db.calls.at(-1)).toEqual({
      query: 'SELECT c_0_sku, c_1_available FROM t_products_active',
      bindings: [],
    });
  });
});
