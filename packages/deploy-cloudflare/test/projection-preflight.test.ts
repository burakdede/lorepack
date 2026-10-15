import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { withTempProject } from '../../../tools/test-support/src/index.ts';
import { preflightProjection } from '../src/projection-preflight.js';

function createCatalog(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY, relative_path TEXT, line_start INTEGER,
      line_end INTEGER, page INTEGER, text TEXT
    );
    CREATE TABLE tables (
      id TEXT PRIMARY KEY, name TEXT, sheet TEXT, sql_name TEXT,
      relative_path TEXT, cell_range TEXT
    );
    CREATE TABLE table_columns (table_id TEXT, sql_name TEXT, ordinal INTEGER);
  `);
  return db;
}

function seedCatalog(path: string, seed: (db: DatabaseSync) => void): void {
  const db = createCatalog(path);
  try {
    seed(db);
  } finally {
    db.close();
  }
}

describe('projection preflight over a real build database', () => {
  it('refuses a missing database with its exact expected path', async () => {
    await withTempProject({}, (project) => {
      expect(() => preflightProjection(project.root)).toThrow(
        expect.objectContaining({
          code: 'LORE_E_BUILD_NOT_FOUND',
          subject: project.path('context.sqlite'),
          remediation: 'Project only a verified sealed build directory.',
        }),
      );
    });
  });

  it('wraps an existing path that SQLite cannot open', async () => {
    await withTempProject({}, (project) => {
      mkdirSync(project.path('context.sqlite'));
      expect(() => preflightProjection(project.root)).toThrow(
        expect.objectContaining({
          code: 'LORE_E_SQLITE_UNAVAILABLE',
          cause: expect.any(Error),
        }),
      );
    });
  });

  it.each([
    { page: 7, lineStart: null, lineEnd: null, label: 'page 7' },
    { page: null, lineStart: 3, lineEnd: 8, label: 'lines 3-8' },
    { page: null, lineStart: null, lineEnd: null, label: '' },
  ])(
    'keeps chunk provenance in size refusals ($label)',
    async ({ page, lineStart, lineEnd, label }) => {
      await withTempProject({}, (project) => {
        seedCatalog(project.path('context.sqlite'), (db) => {
          db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)').run(
            'chunk',
            'guide.pdf',
            lineStart,
            lineEnd,
            page,
            'é'.repeat(1_000_001),
          );
        });
        expect(() => preflightProjection(project.root)).toThrow(
          expect.objectContaining({
            code: 'LORE_E_LIMIT_EXCEEDED',
            message: expect.stringContaining(
              `guide.pdf${label === '' ? '' : ` ${label}`} is 2,000,002 bytes`,
            ),
            subject: 'guide.pdf',
            details: {
              locator: { relativePath: 'guide.pdf', lineStart, lineEnd, page },
              bytes: 2_000_002,
              limit: 2_000_000,
            },
          }),
        );
        const db = new DatabaseSync(project.path('context.sqlite'));
        try {
          expect(db.prepare('SELECT length(text) AS size FROM chunks').get()).toMatchObject({
            size: 1_000_001,
          });
        } finally {
          db.close();
        }
      });
    },
  );

  it('accepts the exact UTF-8 value limit and reports bytes rather than characters', async () => {
    await withTempProject({}, (project) => {
      seedCatalog(project.path('context.sqlite'), (db) => {
        db.prepare('INSERT INTO chunks VALUES (?, ?, NULL, NULL, NULL, ?)').run(
          'chunk',
          'guide.md',
          'é'.repeat(1_000_000),
        );
      });
      expect(preflightProjection(project.root)).toEqual({
        estimatedProjectedBytes: 2_000_000,
        largestContributors: [{ relativePath: 'guide.md', bytes: 2_000_000 }],
      });
    });
  });

  it('accumulates source bytes, sorts ties by path and limits contributor advice to three', async () => {
    await withTempProject({}, (project) => {
      seedCatalog(project.path('context.sqlite'), (db) => {
        const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, NULL, NULL, NULL, ?)');
        for (const [id, path, text] of [
          ['1', 'b.md', 'abcd'],
          ['2', 'a.md', 'é'],
          ['3', 'a.md', 'xy'],
          ['4', 'c.md', '123'],
          ['5', 'd.md', 'x'],
        ] as const)
          insert.run(id, path, text);
      });
      expect(preflightProjection(project.root)).toEqual({
        estimatedProjectedBytes: 12,
        largestContributors: [
          { relativePath: 'a.md', bytes: 4 },
          { relativePath: 'b.md', bytes: 4 },
          { relativePath: 'c.md', bytes: 3 },
        ],
      });
    });
  });

  it('skips tables without projected columns and counts numeric and null cells', async () => {
    await withTempProject({}, (project) => {
      seedCatalog(project.path('context.sqlite'), (db) => {
        db.exec(`
          INSERT INTO tables VALUES ('empty', 'Empty', NULL, 'not_materialized', 'empty.csv', NULL);
          INSERT INTO tables VALUES ('data', 'Data', NULL, 'data_rows', 'data.csv', NULL);
          INSERT INTO table_columns VALUES ('data', 'amount', 0), ('data', 'note', 1);
          CREATE TABLE data_rows (amount REAL, note TEXT);
          INSERT INTO data_rows VALUES (12.5, NULL), (-7, 'é');
        `);
      });
      expect(preflightProjection(project.root)).toEqual({
        estimatedProjectedBytes: 8,
        largestContributors: [{ relativePath: 'data.csv', bytes: 8 }],
      });
    });
  });

  it.each([null, 'Revenue'])(
    'retains table coordinates when a row is too wide (sheet=%s)',
    async (sheet) => {
      await withTempProject({}, (project) => {
        seedCatalog(project.path('context.sqlite'), (db) => {
          db.prepare('INSERT INTO tables VALUES (?, ?, ?, ?, ?, ?)').run(
            'data',
            'Revenue',
            sheet,
            'data_rows',
            'data.xlsx',
            'A1:B2',
          );
          db.exec(`
          INSERT INTO table_columns VALUES ('data', 'first_cell', 0), ('data', 'second_cell', 1);
          CREATE TABLE data_rows (first_cell TEXT, second_cell TEXT);
        `);
          db.prepare('INSERT INTO data_rows VALUES (?, ?)').run(
            'x'.repeat(1_000_000),
            'é'.repeat(500_001),
          );
        });
        expect(() => preflightProjection(project.root)).toThrow(
          expect.objectContaining({
            code: 'LORE_E_LIMIT_EXCEEDED',
            message: expect.stringContaining(
              `data.xlsx${sheet === null ? '' : ` (${sheet})`} is 2,000,002 bytes`,
            ),
            details: {
              locator: { relativePath: 'data.xlsx', sheet, cellRange: 'A1:B2' },
              row: 1,
              table: 'Revenue',
              bytes: 2_000_002,
              limit: 2_000_000,
            },
          }),
        );
      });
    },
  );

  it.each(['table', 'column'])(
    'refuses invalid %s identifiers before executing generated SQL',
    async (kind) => {
      await withTempProject({}, (project) => {
        seedCatalog(project.path('context.sqlite'), (db) => {
          db.prepare('INSERT INTO tables VALUES (?, ?, NULL, ?, ?, NULL)').run(
            'data',
            'Data',
            kind === 'table' ? 'data; DROP TABLE chunks' : 'data_rows',
            'data.csv',
          );
          db.prepare('INSERT INTO table_columns VALUES (?, ?, 0)').run(
            'data',
            kind === 'column' ? 'amount; DROP TABLE chunks' : 'amount',
          );
        });
        expect(() => preflightProjection(project.root)).toThrow(
          expect.objectContaining({
            code: 'LORE_E_INTERNAL',
            message: expect.stringContaining('as a SQL identifier'),
          }),
        );
        const db = new DatabaseSync(project.path('context.sqlite'));
        try {
          expect(db.prepare('SELECT count(*) AS count FROM chunks').get()).toMatchObject({
            count: 0,
          });
        } finally {
          db.close();
        }
      });
    },
  );
});
