import type { fork as forkType } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LoreError, type ParsedTable } from '@lorepack/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqlNameFor, writeTables } from '../src/catalog/tables.js';
import { loadMigrations, runMigrations } from '../src/migrations.js';
import { buildMigrationsDirectory } from '../src/migrations-path.js';
import { executeQuery, QUERY_LIMITS } from '../src/sql/execute.js';

/**
 * What one table query may cost this machine (#559).
 *
 * A query runs in its own child process, and a model writes the query, so the child's memory
 * and the number of children are both bounds a hostile statement must not move. These run the
 * real child against a real build.
 */

const forks = vi.hoisted(() => ({ calls: [] as Parameters<typeof forkType>[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    fork: (...args: Parameters<typeof forkType>) => {
      forks.calls.push(args);
      return actual.fork(...args);
    },
  };
});

let directory: string;
let databasePath: string;
let ordersTable: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'lore-sql-resources-'));
  databasePath = join(directory, 'context.sqlite');
  const db = new DatabaseSync(databasePath);
  runMigrations(db, loadMigrations(buildMigrationsDirectory()), () => '2026-01-01T00:00:00.000Z');
  db.exec(
    `INSERT INTO artifacts VALUES ('a1','s','book.xlsx','book.xlsx','application/x',10,'h','xlsx',
      '0.1.0',NULL,'active',50,'oh','{}')`,
  );
  const orders: ParsedTable = {
    tableId: 'a1#orders',
    name: 'orders',
    sheet: 'Orders',
    columns: [
      {
        name: 'sku',
        type: 'text',
        nullable: false,
        statistics: { nullCount: 0, distinctEstimate: 1, distinctIsExact: true },
      },
    ],
    rows: Array.from({ length: 5_000 }, (_, index) => [`A-${String(index)}`]),
    locator: {
      artifactId: 'a1',
      relativePath: 'book.xlsx',
      sheet: 'Orders',
      cellRange: 'A1:A5001',
    },
    metadata: {},
  };
  db.exec('BEGIN');
  writeTables(db, [orders]);
  db.exec('COMMIT');
  db.close();
  ordersTable = sqlNameFor('a1#orders', 'Orders');
});

afterAll(() => {
  // A killed child may still hold the file open for a moment on Windows; see sql-surface.test.ts.
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Left for the operating system to reclaim.
  }
});

beforeEach(() => {
  forks.calls.length = 0;
});

async function failure(sql: string, limit?: number): Promise<LoreError> {
  const caught = await executeQuery({
    databasePath,
    allowedTables: [ordersTable],
    sql,
    ...(limit === undefined ? {} : { limit }),
  }).catch((error: unknown) => error);
  expect(caught, sql).toBeInstanceOf(LoreError);
  return caught as LoreError;
}

const RUNAWAY =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c';

describe('the query child', () => {
  /**
   * The issue's reproduction, run without the statement guard in front (which now refuses a
   * `printf` width this large), so the child's own bounds are what is measured. Before #559 it
   * materialised every row before checking the size: 3,950 MB peak RSS.
   */
  it('stops at the response cap while its memory stays under the documented ceiling', async () => {
    const error = await failure(
      `SELECT printf('%.*c', 999999, c_0_sku) AS a FROM ${ordersTable}`,
      QUERY_LIMITS.maxRows,
    );
    expect(error.code, error.message).toBe('LORE_E_LIMIT_EXCEEDED');
    const peak = (error.details as { childPeakRssBytes?: number } | undefined)?.childPeakRssBytes;
    expect(peak).toBeTypeOf('number');
    expect(peak).toBeLessThan(QUERY_LIMITS.childRssCeilingBytes);
  }, 30_000);

  it('caps the JavaScript heap of every child it starts', async () => {
    await executeQuery({
      databasePath,
      allowedTables: [ordersTable],
      sql: `SELECT count(*) AS n FROM ${ordersTable}`,
    });
    expect(forks.calls).toHaveLength(1);
    const options = forks.calls[0]?.[2] as { execArgv?: readonly string[] } | undefined;
    expect(options?.execArgv).toEqual([`--max-old-space-size=${String(QUERY_LIMITS.childHeapMb)}`]);
  });
});

describe('how many queries may run at once', () => {
  it('refuses one past the limit with a typed busy error, without starting a process', async () => {
    const running = Array.from({ length: QUERY_LIMITS.maxConcurrent }, () => failure(RUNAWAY));
    const refused = await failure(`SELECT count(*) AS n FROM ${ordersTable}`);
    expect(refused.code).toBe('LORE_E_BUSY');
    expect(forks.calls).toHaveLength(QUERY_LIMITS.maxConcurrent);

    for (const error of await Promise.all(running))
      expect(error.code).toBe('LORE_E_LIMIT_EXCEEDED');

    // A slot is released when its query ends, however it ended.
    const after = await executeQuery({
      databasePath,
      allowedTables: [ordersTable],
      sql: `SELECT count(*) AS n FROM ${ordersTable}`,
    });
    expect(after.rows[0]).toMatchObject({ n: 5_000 });
  }, 30_000);
});
