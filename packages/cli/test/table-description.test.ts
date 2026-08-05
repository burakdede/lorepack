import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import {
  boolean_,
  empty,
  makeXlsx,
  number,
  row,
  shared,
  withTempProject,
} from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { run } from './helpers.js';

/**
 * What a caller learns about a typed table (#235).
 *
 * The contract suite holds every backend to the invariants. These are the local specifics the
 * contract cannot state: the exact cell range an XLSX sheet was read from, what `lore inspect
 * tables` prints beside what the port returns, and what happens to a build written at an older
 * catalog schema.
 */

const CONFIG = 'version: 1\nname: shop\nsources:\n  - .\n';

const PRICING_CSV = [
  'sku,list_price,discontinued',
  'A-1,19.99,false',
  'A-2,4.50,false',
  'A-3,,true',
  '',
].join('\n');

/** One sheet, four columns, with a null in the boolean so its type is load-bearing. */
function workbook(): Promise<Uint8Array> {
  return makeXlsx({
    sharedStrings: ['sku', 'region', 'qty', 'active', 'A-1', 'A-2', 'A-3', 'EU', 'US'],
    sheets: [
      {
        name: 'Orders',
        rows: [
          row(1, [shared('A1', 0), shared('B1', 1), shared('C1', 2), shared('D1', 3)]),
          row(2, [shared('A2', 4), shared('B2', 7), number('C2', 5), boolean_('D2', true)]),
          row(3, [shared('A3', 5), shared('B3', 8), number('C3', 2), boolean_('D3', false)]),
          row(4, [shared('A4', 6), shared('B4', 7), number('C4', 9), empty('D4')]),
        ],
      },
    ],
  });
}

async function withProject<T>(
  body: (context: {
    root: string;
    runtime: ReturnType<typeof createRuntime>;
    close: () => void;
    lore: (args: string[]) => ReturnType<typeof run>;
  }) => Promise<T>,
): Promise<T> {
  const bytes = await workbook();
  return withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
    writeFileSync(join(temp.root, 'orders.xlsx'), bytes);
    writeFileSync(join(temp.root, 'pricing.csv'), PRICING_CSV, 'utf8');
    await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });

    const backend = createLocalRuntimeBackend({ projectRoot: temp.root });
    try {
      return await body({
        root: temp.root,
        runtime: createRuntime(backend),
        close: () => backend.close(),
        lore: (args) => run(['--cwd', temp.root, ...args]),
      });
    } finally {
      backend.close();
    }
  });
}

const XLSX_TABLE = 'shop:orders.xlsx#orders';
const CSV_TABLE = 'shop:pricing.csv#table';

describe('a table description carries where it came from', () => {
  it('reports the sheet and the cell range an XLSX table was read from', async () => {
    await withProject(async ({ runtime }) => {
      const described = await runtime.describeTable(XLSX_TABLE);

      expect(described.sheet).toBe('Orders');
      expect(described.locator.sheet).toBe('Orders');
      // The whole region, header row included, which is what the parser recorded.
      expect(described.locator.cellRange).toBe('A1:D4');
    });
  });

  it('invents neither a sheet nor a cell range for a CSV', async () => {
    await withProject(async ({ runtime }) => {
      const described = await runtime.describeTable(CSV_TABLE);

      expect(described.sheet).toBeUndefined();
      expect(described.locator.sheet).toBeUndefined();
      expect(described.locator.cellRange).toBeUndefined();
      // It has line numbers instead, because for a CSV that is the honest span.
      expect(described.locator.lineStart).toBe(1);
    });
  });
});

describe('a table description carries what was measured', () => {
  it('returns the statistics the catalog stored', async () => {
    await withProject(async ({ runtime }) => {
      const described = await runtime.describeTable(XLSX_TABLE);
      const byName = new Map(described.columns.map((column) => [column.name, column]));

      expect(byName.get('sku')?.statistics).toEqual({
        nullCount: 0,
        distinctEstimate: 3,
        distinctIsExact: true,
        min: 'A-1',
        max: 'A-3',
      });
      // Numbers, not the text they are stored as.
      expect(byName.get('qty')?.statistics).toEqual({
        nullCount: 0,
        distinctEstimate: 3,
        distinctIsExact: true,
        min: 2,
        max: 9,
      });
      // Booleans, likewise, and the one null is counted.
      expect(byName.get('active')?.statistics).toEqual({
        nullCount: 1,
        distinctEstimate: 2,
        distinctIsExact: true,
        min: false,
        max: true,
      });
    });
  });

  it('reports a real column bound as a number, including a fractional one', async () => {
    await withProject(async ({ runtime }) => {
      const described = await runtime.describeTable(CSV_TABLE);
      const price = described.columns.find((column) => column.name === 'list_price');

      expect(price?.type).toBe('real');
      expect(price?.statistics.min).toBe(4.5);
      expect(price?.statistics.max).toBe(19.99);
    });
  });
});

describe('a boolean is a boolean wherever it is reported', () => {
  it('decodes the sample, the query rows and the bounds together', async () => {
    await withProject(async ({ runtime }) => {
      const described = await runtime.describeTable(XLSX_TABLE);
      const column = described.columns.find((one) => one.name === 'active');
      if (column === undefined) throw new Error('the active column is missing');

      expect(described.sample.map((sampled) => sampled.active)).toEqual([true, false, null]);

      const queried = await runtime.queryTable({
        tableId: XLSX_TABLE,
        sql: `SELECT ${column.sqlName} FROM ${described.sqlName}`,
      });
      expect(queried.rows.map((queriedRow) => queriedRow.active)).toEqual([true, false, null]);
    });
  });

  /**
   * The rule, asserted rather than assumed: a column this can name is a column it can decode.
   *
   * An expression has no catalog counterpart, so it is neither renamed nor decoded. That is
   * one rule degrading predictably, and the alternative is two rules that eventually disagree.
   */
  it('leaves a computed column alone, name and value together', async () => {
    await withProject(async ({ runtime }) => {
      const described = await runtime.describeTable(XLSX_TABLE);
      const active = described.columns.find((one) => one.name === 'active');
      if (active === undefined) throw new Error('the active column is missing');

      const queried = await runtime.queryTable({
        tableId: XLSX_TABLE,
        sql: `SELECT count(*) AS total, max(${active.sqlName}) AS ever FROM ${described.sqlName}`,
      });

      expect(queried.columns).toEqual(['total', 'ever']);
      // Still the storage class, because nothing said this expression was a boolean.
      expect(queried.rows[0]?.ever).toBe(1);
      expect(queried.rows[0]?.total).toBe(3);
    });
  });
});

describe('the description is enough to write a query', () => {
  it('runs SQL assembled from nothing but the description', async () => {
    await withProject(async ({ runtime }) => {
      const described = await runtime.describeTable(XLSX_TABLE);
      const columns = described.columns.map((column) => column.sqlName).join(', ');

      const queried = await runtime.queryTable({
        tableId: XLSX_TABLE,
        sql: `SELECT ${columns} FROM ${described.sqlName} ORDER BY ${described.columns[2]?.sqlName ?? ''} DESC`,
      });

      expect(queried.rowCount).toBe(3);
      expect(queried.rows.map((queriedRow) => queriedRow.qty)).toEqual([9, 5, 2]);
    });
  });

  it('sends a caller who used the source name to the field that works', async () => {
    await withProject(async ({ runtime }) => {
      await expect(
        runtime.queryTable({ tableId: XLSX_TABLE, sql: 'SELECT sku FROM Orders' }),
      ).rejects.toMatchObject({
        code: 'LORE_E_SQL_REJECTED',
        remediation: expect.stringContaining('sqlName'),
      });
    });
  });
});

describe('the CLI and the port describe one table one way', () => {
  it('prints the statistics the port reports, and the generated names', async () => {
    await withProject(async ({ runtime, lore }) => {
      const described = await runtime.describeTable(XLSX_TABLE);
      const printed = await lore(['inspect', 'tables', XLSX_TABLE]);

      expect(printed.code).toBe(0);
      // The generated names are on screen, because they are what a query needs and nothing
      // else prints them.
      expect(printed.stdout).toContain(described.sqlName);
      for (const column of described.columns) {
        expect(printed.stdout).toContain(column.sqlName);
        expect(printed.stdout).toContain(column.name);
      }

      // And the JSON is the port's own shape, not a second one assembled here.
      const asJson = await lore(['--json', 'inspect', 'tables', XLSX_TABLE]);
      const parsed = JSON.parse(asJson.stdout) as { table: typeof described };
      expect(parsed.table.columns).toEqual(described.columns);
      expect(parsed.table.locator).toEqual(described.locator);
    });
  });
});

describe('a build written at an older catalog schema', () => {
  /**
   * Refused at the boundary, with something to do about it.
   *
   * A sealed build is never migrated: migrations run only against a writable database and a
   * build is opened read-only. Without the check the first symptom is whatever statement
   * happens to name a column that did not exist yet, from inside a query, with nothing saying
   * the cause is an old build.
   */
  it('is refused with a typed error naming the fix, not a SQLite one', async () => {
    await withProject(async ({ root, close }) => {
      // The backend caches open databases, so the one under test has to be a fresh one.
      close();

      const buildsRoot = join(root, '.lore', 'builds');
      const { readdirSync } = await import('node:fs');
      const buildId = readdirSync(buildsRoot)[0] as string;
      const database = join(buildsRoot, buildId, 'context.sqlite');

      // Rewind the build by one migration, whichever is latest. Naming a migration here
      // would make this test stop exercising the guard the moment another one is added,
      // which is exactly what happened when 0004 arrived.
      const writable = new DatabaseSync(database);
      writable.exec(
        'DELETE FROM schema_migrations WHERE id = (SELECT max(id) FROM schema_migrations)',
      );
      writable.close();

      const backend = createLocalRuntimeBackend({ projectRoot: root });
      try {
        const runtime = createRuntime(backend);
        await expect(runtime.describeBuild()).rejects.toMatchObject({
          code: 'LORE_E_SCHEMA_MISMATCH',
          remediation: expect.stringContaining('lore build'),
        });
      } finally {
        backend.close();
      }
    });
  });
});
