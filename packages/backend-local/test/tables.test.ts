import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ParsedColumn, ParsedTable } from '@lorepack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertIdentifier,
  describeStoredTable,
  listTableRows,
  physicalTableNames,
  resolveTable,
  sqlNameFor,
  writeTables,
} from '../src/catalog/tables.js';
import { loadMigrations, runMigrations } from '../src/migrations.js';
import { buildMigrationsDirectory } from '../src/migrations-path.js';

/**
 * Typed tables in a real SQLite database.
 *
 * The tests worth writing here are the hostile ones. A table name and a column name both
 * arrive from a user's file, and the only thing standing between `"; DROP TABLE artifacts;`
 * and a `CREATE TABLE` statement is name generation. So most of this file is spreadsheets
 * that a person would never make and an attacker would.
 */

let directory: string;
let db: DatabaseSync;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lore-tables-'));
  db = new DatabaseSync(join(directory, 'build.sqlite'));
  runMigrations(db, loadMigrations(buildMigrationsDirectory()), () => '2026-01-01T00:00:00.000Z');
  // Tables reference artifacts, so one has to exist for the foreign key to hold.
  db.exec(
    `INSERT INTO artifacts VALUES ('a1','s','data.csv','data.csv','text/csv',10,'h','csv','0.1.0',
      NULL,'active',50,'oh','{}')`,
  );
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function column(name: string, overrides: Partial<ParsedColumn> = {}): ParsedColumn {
  return {
    name,
    type: 'text',
    nullable: false,
    statistics: { nullCount: 0, distinctEstimate: 1, distinctIsExact: true },
    ...overrides,
  };
}

function table(overrides: Partial<ParsedTable> = {}): ParsedTable {
  return {
    tableId: 'a1#table',
    name: 'data',
    columns: [column('a'), column('b')],
    rows: [
      ['1', '2'],
      ['3', '4'],
    ],
    locator: { artifactId: 'a1', relativePath: 'data.csv', lineStart: 1, lineEnd: 3 },
    metadata: {},
    ...overrides,
  };
}

describe('generated SQL names', () => {
  it('never lets user text reach an identifier', () => {
    const hostile = [
      '"; DROP TABLE artifacts; --',
      "Robert'); DROP TABLE students;--",
      'name with spaces',
      'ORDER BY',
      'select',
      '日本語のシート',
      '../../etc/passwd',
      '`backticks`',
      'a'.repeat(200),
      '',
      '!!!',
    ];
    for (const name of hostile) {
      const generated = sqlNameFor(`id:${name}`, name);
      expect(generated).toMatch(/^t_[a-z0-9_]+$/);
      expect(generated.length).toBeLessThanOrEqual(63);
    }
  });

  it('is deterministic, so the same file names the same table on every machine', () => {
    expect(sqlNameFor('a1#table', 'Q3 Report')).toBe(sqlNameFor('a1#table', 'Q3 Report'));
  });

  /**
   * The slug is lossy and two sheets can slug identically; the hash of the table id is what
   * makes them distinct. If this ever failed, the second `CREATE TABLE` would collide.
   */
  it('separates two tables whose names slug to the same string', () => {
    expect(sqlNameFor('a#1', 'Q3 Report')).not.toBe(sqlNameFor('a#2', 'Q3/Report'));
  });

  it('refuses an identifier that did not come from the generator', () => {
    expect(() => assertIdentifier('artifacts; DROP TABLE x')).toThrowError(/Refusing to use/);
    expect(() => assertIdentifier('T_Upper')).toThrowError(/Refusing to use/);
  });
});

describe('import', () => {
  it('creates a physical table and fills it', () => {
    const result = writeTables(db, [table()]);
    expect(result).toEqual({ tables: 1, rows: 2 });

    const resolved = resolveTable(db, 'a1#table');
    expect(resolved?.table.sql_name).toMatch(/^t_data_/);
    const rows = db.prepare(`SELECT * FROM ${resolved?.table.sql_name as string}`).all();
    expect(rows).toHaveLength(2);
  });

  it('survives a spreadsheet whose column names are SQL', () => {
    writeTables(db, [
      table({
        columns: [column('"; DROP TABLE artifacts; --'), column('1 OR 1=1')],
        rows: [['x', 'y']],
      }),
    ]);
    // The catalog still exists, which it would not if the DDL had been interpreted.
    expect(db.prepare('SELECT count(*) AS n FROM artifacts').get()).toEqual({ n: 1 });
    const described = describeStoredTable(db, 'a1#table', 5);
    // The source names survive for the reader even though SQL never saw them.
    expect(described?.columns.map((one) => one.name)).toEqual([
      '"; DROP TABLE artifacts; --',
      '1 OR 1=1',
    ]);
    expect(described?.sample[0]).toEqual({ '"; DROP TABLE artifacts; --': 'x', '1 OR 1=1': 'y' });
  });

  it('writes each type into its SQLite storage class', () => {
    writeTables(db, [
      table({
        columns: [
          column('n', { type: 'integer' }),
          column('r', { type: 'real' }),
          column('b', { type: 'boolean' }),
          column('d', { type: 'date' }),
        ],
        rows: [[7, 1.5, true, '2026-01-01']],
      }),
    ]);
    const resolved = resolveTable(db, 'a1#table');
    const row = db.prepare(`SELECT * FROM ${resolved?.table.sql_name as string}`).get() as Record<
      string,
      unknown
    >;
    // A boolean is stored as 1: node:sqlite binds no boolean, and a STRICT table needs a
    // declared storage class. Reading it back as a boolean is the query layer's job.
    expect(Object.values(row)).toEqual([7, 1.5, 1, '2026-01-01']);
  });

  it('stores a null rather than an empty string for a missing cell', () => {
    writeTables(db, [table({ rows: [['1', null]] })]);
    const resolved = resolveTable(db, 'a1#table');
    const row = db.prepare(`SELECT * FROM ${resolved?.table.sql_name as string}`).get() as Record<
      string,
      unknown
    >;
    expect(Object.values(row)).toEqual(['1', null]);
  });

  /**
   * Batching is where an off-by-one hides: the last partial batch uses a different statement
   * from the full ones. A row count that is not a multiple of the batch size proves both.
   */
  it('imports a row count that is not a multiple of the batch size', () => {
    const rows = Array.from({ length: 1234 }, (_, index) => [String(index), 'x']);
    expect(writeTables(db, [table({ rows })]).rows).toBe(1234);
    const resolved = resolveTable(db, 'a1#table');
    expect(
      db.prepare(`SELECT count(*) AS n FROM ${resolved?.table.sql_name as string}`).get(),
    ).toEqual({ n: 1234 });
  });

  it('imports a table with no rows', () => {
    expect(writeTables(db, [table({ rows: [] })]).rows).toBe(0);
    expect(describeStoredTable(db, 'a1#table', 5)?.rowCount).toBe(0);
  });

  /**
   * #76 requires a mid-import failure to leave nothing behind. The transaction is the
   * caller's, which is what makes that true for the whole build rather than one table.
   */
  it('leaves no trace when the caller rolls back', () => {
    db.exec('BEGIN');
    writeTables(db, [table()]);
    db.exec('ROLLBACK');
    expect(listTableRows(db)).toEqual([]);
    expect(physicalTableNames(db)).toEqual([]);
  });
});

describe('reading', () => {
  it('lists and describes with statistics and provenance', () => {
    writeTables(db, [
      table({
        columns: [
          column('zip'),
          column('amount', {
            type: 'integer',
            nullable: true,
            statistics: {
              nullCount: 1,
              distinctEstimate: 2,
              distinctIsExact: true,
              min: 1,
              max: 9,
            },
          }),
        ],
        rows: [
          ['00123', 1],
          ['00124', null],
        ],
      }),
    ]);

    expect(listTableRows(db)).toEqual([{ tableId: 'a1#table', name: 'data' }]);
    const described = describeStoredTable(db, 'a1#table', 5);
    expect(described?.rowCount).toBe(2);
    expect(described?.columns[1]).toEqual({
      name: 'amount',
      sqlName: 'c_1_amount',
      type: 'integer',
      nullable: true,
      // Reported, not merely stored. They reached no reader through the port until #235, and
      // the bounds come back as numbers because the column is an integer, though the catalog
      // holds them as text.
      statistics: { nullCount: 1, distinctEstimate: 2, distinctIsExact: true, min: 1, max: 9 },
    });
    // Provenance is mandatory, not decorative: a description without a locator is a bug.
    expect(described?.locator).toEqual({
      artifactId: 'a1',
      relativePath: 'data.csv',
      lineStart: 1,
      lineEnd: 3,
    });
    // The leading zero survived the round trip through storage, which is the whole point.
    expect(described?.sample[0]?.zip).toBe('00123');
  });

  it('returns null for a table that does not exist', () => {
    expect(describeStoredTable(db, 'nope', 5)).toBeNull();
  });

  it('bounds the sample rather than returning the table', () => {
    writeTables(db, [
      table({ rows: Array.from({ length: 100 }, (_, index) => [String(index), 'x']) }),
    ]);
    expect(describeStoredTable(db, 'a1#table', 5)?.sample).toHaveLength(5);
  });

  it('reports every physical table, for the authorizer to permit', () => {
    writeTables(db, [table(), table({ tableId: 'a1#two', name: 'other' })]);
    expect(physicalTableNames(db)).toHaveLength(2);
    expect(physicalTableNames(db).every((name) => name.startsWith('t_'))).toBe(true);
  });
});
