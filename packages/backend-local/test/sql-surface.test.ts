import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LoreError, type ParsedTable } from '@lorepack/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlNameFor, writeTables } from '../src/catalog/tables.js';
import { loadMigrations, runMigrations } from '../src/migrations.js';
import { buildMigrationsDirectory } from '../src/migrations-path.js';
import { executeQuery, QUERY_LIMITS } from '../src/sql/execute.js';
import { validateStatement } from '../src/sql/statement.js';

/**
 * The model-facing SQL surface, which is the highest-risk thing in the product.
 *
 * The suite is deliberately split. The statement tests check *shape* and are pure. The
 * execution tests check what the **authorizer** does, and they matter more: #77 requires the
 * security properties to hold with statement validation disabled, so most of the hostile cases
 * below are queries the tokenizer happily accepts and the engine refuses.
 */

let directory: string;
let databasePath: string;
let ordersTable: string;
let secretsTable: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'lore-sql-'));
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
    columns: [column('sku'), column('qty', 'integer'), column('price', 'real')],
    rows: [
      ['A-1', 5, 9.99],
      ['A-2', 2, 4.5],
      ['A-3', 8, 1.25],
    ],
    locator: { artifactId: 'a1', relativePath: 'book.xlsx', sheet: 'Orders', cellRange: 'A1:C4' },
    metadata: {},
  };
  // A second table in the same build, which a query against the first must never be able to
  // read. This is the point of scoping the authorizer per query rather than per build.
  const secrets: ParsedTable = {
    ...orders,
    tableId: 'a1#secrets',
    name: 'secrets',
    sheet: 'Secrets',
    columns: [column('token')],
    rows: [['s3cret']],
  };

  db.exec('BEGIN');
  writeTables(db, [orders, secrets]);
  db.exec('COMMIT');
  db.close();

  ordersTable = sqlNameFor('a1#orders', 'Orders');
  secretsTable = sqlNameFor('a1#secrets', 'Secrets');
});

afterAll(() => {
  // Best effort, and deliberately not an assertion.
  //
  // A query runs in a child process killed with `SIGKILL`, and the kill is not awaited: that
  // is the whole point of the design, because waiting on a process being killed reintroduces
  // the hang that ruled out worker threads. For a while afterwards the dead child still holds
  // the build file open, and Windows refuses to delete an open file with `EPERM`. POSIX
  // unlinks it happily, which is why this only ever appeared in CI.
  //
  // Retrying for a bounded time and then giving up is the right shape: this directory is
  // under the OS temp directory, which the OS reclaims. Failing the suite over it would mean
  // a green test run reporting a red result about nothing.
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Left for the operating system to reclaim.
  }
});

function column(
  name: string,
  type: 'text' | 'integer' | 'real' = 'text',
): ParsedTable['columns'][number] {
  return {
    name,
    type,
    nullable: false,
    statistics: { nullCount: 0, distinctEstimate: 1, distinctIsExact: true },
  };
}

async function query(
  sql: string,
  limit?: number,
): Promise<Awaited<ReturnType<typeof executeQuery>>> {
  return executeQuery({
    databasePath,
    allowedTables: [ordersTable],
    sql,
    ...(limit === undefined ? {} : { limit }),
  });
}

const failure = async (sql: string, limit?: number): Promise<LoreError> => {
  const caught = await query(sql, limit).catch((error: unknown) => error);
  expect(caught, sql).toBeInstanceOf(LoreError);
  return caught as LoreError;
};

describe('statement shape', () => {
  it('accepts the queries someone actually writes', () => {
    for (const sql of [
      'SELECT * FROM t',
      'select * from t',
      '  SELECT 1  ',
      'SELECT 1;',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      "SELECT c FROM t WHERE c = 'a;b'",
      'SELECT count(*) FROM t /* a note */',
      '-- a note\nSELECT 1',
      'VALUES (1), (2)',
      'SELECT row_number() OVER (ORDER BY c) FROM t',
    ]) {
      expect(() => validateStatement(sql), sql).not.toThrow();
    }
  });

  /**
   * The comment cases #77 names. They are not special-cased: a `--` comment ends at the
   * newline and a `/* *\/` comment does not, so the semicolon in the first is a separator and
   * the one in the second is text.
   */
  it('sees a statement hidden after a comment, and does not invent one inside a comment', () => {
    expect(() => validateStatement('SELECT 1 -- x\n; DROP TABLE artifacts')).toThrowError(
      /more than one/,
    );
    expect(() => validateStatement('SELECT 1 /* ; DROP TABLE artifacts */')).not.toThrow();
  });

  it('refuses more than one statement, however it is written', () => {
    for (const sql of [
      'SELECT 1; DROP TABLE artifacts',
      'SELECT 1;SELECT 2',
      '/* x */ SELECT 1; /* y */ DELETE FROM artifacts',
      'SELECT 1 ;\n\n DROP TABLE t',
    ]) {
      expect(() => validateStatement(sql), sql).toThrowError(/more than one/);
    }
  });

  it('refuses anything that is not a read', () => {
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET a = 1',
      'DELETE FROM t',
      'CREATE TABLE x (a)',
      'DROP TABLE x',
      'ALTER TABLE t ADD COLUMN b',
      'PRAGMA table_info(artifacts)',
      "ATTACH DATABASE '/etc/passwd' AS x",
      'DETACH DATABASE x',
      'BEGIN',
      'VACUUM',
      'REPLACE INTO t VALUES (1)',
    ]) {
      expect(() => validateStatement(sql), sql).toThrowError(LoreError);
    }
  });

  /** `WITH ... INSERT` starts with an allowed keyword and is a write. */
  it('refuses a common table expression that ends in a write', () => {
    expect(() =>
      validateStatement('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x'),
    ).toThrowError(/must end in a SELECT/);
  });

  /**
   * A semicolon inside a quoted identifier or a string is text. Reading it as a separator
   * would reject legitimate queries; reading a real separator as text would be far worse, so
   * both directions are asserted.
   */
  it('does not mistake a semicolon inside a literal or an identifier for a separator', () => {
    expect(() => validateStatement(`SELECT 'a;b' FROM t`)).not.toThrow();
    expect(() => validateStatement(`SELECT "c;d" FROM t`)).not.toThrow();
    expect(() => validateStatement('SELECT [c;d] FROM t')).not.toThrow();
    expect(() => validateStatement("SELECT 'it''s; fine' FROM t")).not.toThrow();
  });

  it('fails closed on text it cannot read to the end', () => {
    expect(() => validateStatement("SELECT 'unterminated")).toThrowError(/ends inside/);
    expect(() => validateStatement('SELECT 1 /* unterminated')).toThrowError(/ends inside/);
    expect(() => validateStatement('')).toThrowError(/empty/);
  });
});

describe('the authorizer, which is the control', () => {
  it('runs an ordinary query and returns its rows', async () => {
    const result = await query(`SELECT * FROM ${ordersTable}`);
    expect(result.rows).toHaveLength(3);
    // Relabelling happens in the store; the executor returns physical names, and the columns
    // it reports must name the keys of the rows it returns.
    expect(result.columns).toEqual(Object.keys(result.rows[0] as object));
  });

  /**
   * The property the per-query allowlist exists for. This query is a single valid SELECT, so
   * statement validation passes it without complaint. Only the authorizer stops it.
   */
  it('refuses another table in the same build', async () => {
    const error = await failure(`SELECT * FROM ${secretsTable}`);
    expect(error.code).toBe('LORE_E_SQL_REJECTED');
    // The message must not disclose that the other table exists, nor name it.
    expect(error.message).not.toContain('secret');
    expect(JSON.stringify(error)).not.toContain('s3cret');
  });

  it('refuses the catalog that would reveal the other tables', async () => {
    for (const sql of [
      'SELECT * FROM tables',
      'SELECT * FROM table_columns',
      'SELECT * FROM artifacts',
      'SELECT * FROM sqlite_master',
      'SELECT * FROM sqlite_schema',
      `SELECT * FROM ${ordersTable} UNION SELECT sql, 1, 2 FROM sqlite_master`,
    ]) {
      const error = await failure(sql);
      expect(error.code, sql).toBe('LORE_E_SQL_REJECTED');
    }
  });

  it('refuses functions that reach outside the query', async () => {
    for (const sql of [
      `SELECT load_extension('/tmp/x.so')`,
      `SELECT readfile('/etc/passwd')`,
      `SELECT writefile('/tmp/x', 'y')`,
      `SELECT sqlite_version()`,
      `SELECT random()`,
    ]) {
      const error = await failure(sql);
      expect(error.code, sql).toBe('LORE_E_SQL_REJECTED');
    }
  });

  it('allows the functions a person querying a spreadsheet needs', async () => {
    const result = await query(
      `SELECT count(*) AS n, sum(c_1_qty) AS total, upper(min(c_0_sku)) AS first FROM ${ordersTable}`,
    );
    expect(result.rows[0]).toMatchObject({ n: 3, total: 15 });
  });

  it('allows a window function, which the parser we rejected could not even parse', async () => {
    const result = await query(
      `SELECT c_0_sku, row_number() OVER (ORDER BY c_1_qty DESC) AS rank FROM ${ordersTable}`,
    );
    expect(result.rows).toHaveLength(3);
  });
});

describe('bounds', () => {
  it('injects a default limit when the query has none', async () => {
    const result = await query(`SELECT * FROM ${ordersTable}`);
    expect(result.rows.length).toBeLessThanOrEqual(QUERY_LIMITS.defaultRows);
    expect(result.truncated).toBe(false);
  });

  it('reports truncation rather than quietly returning fewer rows', async () => {
    const result = await query(`SELECT * FROM ${ordersTable}`, 2);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  /**
   * A compound SELECT is why the limit is applied by wrapping rather than by appending: an
   * appended `LIMIT` binds to the last arm of a UNION, not to the whole result.
   */
  it('bounds a compound select as a whole', async () => {
    const result = await query(
      `SELECT * FROM ${ordersTable} UNION ALL SELECT * FROM ${ordersTable}`,
      2,
    );
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('does not let a caller ask for more than the ceiling', async () => {
    const result = await query(`SELECT * FROM ${ordersTable}`, 1_000_000);
    expect(result.rows).toHaveLength(3);
  });

  /**
   * The measurement that justifies the worker thread: `db.limits.vdbeOp` does not stop this,
   * and on the main thread it would hold the event loop indefinitely.
   */
  it('stops a runaway recursive query on the deadline', async () => {
    const started = Date.now();
    const error = await failure(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
    );
    expect(error.code).toBe('LORE_E_LIMIT_EXCEEDED');
    expect(Date.now() - started).toBeLessThan(QUERY_LIMITS.deadlineMs * 3);
    expect(error.remediation).toContain('termination condition');
  }, 30_000);

  it('serves other queries normally after a deadline kill', async () => {
    await failure(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
    );
    const result = await query(`SELECT count(*) AS n FROM ${ordersTable}`);
    expect(result.rows[0]).toMatchObject({ n: 3 });
  }, 30_000);
});

describe('what an error is allowed to say', () => {
  it('never discloses a filesystem path', async () => {
    for (const sql of [
      `SELECT * FROM ${secretsTable}`,
      'SELECT * FROM sqlite_master',
      'SELECT * FROM nope',
      `SELECT readfile('/etc/passwd')`,
    ]) {
      const error = await failure(sql);
      const text = `${error.message} ${error.remediation ?? ''}`;
      expect(text, sql).not.toContain(directory);
      expect(text, sql).not.toContain('.sqlite');
      expect(text, sql).not.toContain(tmpdir());
    }
  });

  it('points at describeTable when a name does not resolve, which is the useful next step', async () => {
    const error = await failure('SELECT * FROM not_a_table');
    expect(error.remediation).toContain('describeTable');
  });
});

/**
 * A typo is not an attempted write (#253).
 *
 * `SELEC * FROM t` used to be refused with "Only SELECT is allowed here, and this statement
 * begins with SELEC", plus a remediation explaining that the surface is read-only by design.
 * Both sentences are about a rule the user did not break, and a reader would reasonably
 * conclude their SELECT had been rejected as a write.
 */
describe('a misspelled first word', () => {
  const message = (sql: string): { message: string; remediation?: string } => {
    try {
      validateStatement(sql);
    } catch (error) {
      return error as { message: string; remediation?: string };
    }
    throw new Error(`expected ${sql} to be refused`);
  };

  it('is named as a misspelling rather than as a write', () => {
    const refusal = message('SELEC * FROM t');
    expect(refusal.message).toContain('not a SQL keyword');
    expect(refusal.message).not.toContain('Only SELECT is allowed');
    // Nothing about the read-only rule, which this user did not break.
    expect(refusal.remediation).not.toMatch(/read-only/i);
  });

  it('suggests the keyword when one is a single edit away', () => {
    for (const [typo, meant] of [
      ['SELEC', 'SELECT'],
      ['SELCT', 'SELECT'],
      // A transposition, which is the typo people actually make and which two substitutions
      // would miss.
      ['WTIH', 'WITH'],
      ['SELETC', 'SELECT'],
    ] as const) {
      expect(message(`${typo} 1`).remediation).toBe(`Did you mean ${meant}?`);
    }
  });

  it('suggests nothing when nothing is close, rather than guessing', () => {
    expect(message('banana me').remediation).toBe('Check the spelling of the first word.');
  });

  it('still calls a real write a write', () => {
    for (const write of ['DELETE FROM t', 'DROP TABLE t', 'UPDATE t SET a = 1', 'PRAGMA x']) {
      const refusal = message(write);
      expect(refusal.message).toContain('Only SELECT is allowed');
      expect(refusal.remediation).toMatch(/read-only/i);
    }
  });
});
