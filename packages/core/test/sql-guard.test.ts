import { describe, expect, it } from 'vitest';
import {
  guardSingleTableQuery,
  QUERY_GUARD_LIMITS,
  type QueryProfile,
  type SingleTableQuery,
} from '../src/sql/guard.js';
import { lexSql } from '../src/sql/lexer.js';

/**
 * The statement guard, rule by rule (#406).
 *
 * The shared runtime contract proves both backends refuse real attempts against real
 * databases. These pin each rule on its own, including the forms a regular expression or a
 * hand-written tokenizer typically gets wrong, so a regression names the rule it broke.
 */

const TABLE = 'products_0123456789abcdef';
const SCHEMA = [
  TABLE,
  'tables',
  'table_columns',
  'chunks',
  'artifacts',
  'runtime_tokens',
  'active_build',
  'other_fedcba9876543210',
];

function guard(
  sql: string,
  profile: QueryProfile = 'remote',
  overrides: Partial<SingleTableQuery> = {},
): string {
  return guardSingleTableQuery(sql, {
    table: TABLE,
    schemaNames: SCHEMA,
    profile,
    rowCount: 100,
    ...overrides,
  });
}

const REFUSED = { code: 'LORE_E_SQL_REJECTED' };

function refuses(sql: string, profile: QueryProfile = 'remote'): void {
  expect(() => guard(sql, profile), sql).toThrow(expect.objectContaining(REFUSED));
}

describe('names of other objects', () => {
  it.each([
    `SELECT sku FROM ${TABLE}, runtime_tokens`,
    `SELECT sku FROM ${TABLE} JOIN/**/runtime_tokens`,
    `SELECT sku FROM ${TABLE} JOIN "runtime_tokens"`,
    `SELECT sku FROM ${TABLE} JOIN \`runtime_tokens\``,
    `SELECT sku FROM ${TABLE} JOIN [runtime_tokens]`,
    `SELECT sku FROM ${TABLE}, 'runtime_tokens'`,
    `SELECT sku FROM ${TABLE} WHERE sku IN 'runtime_tokens'`,
    `SELECT sku FROM ${TABLE} JOIN main.chunks`,
    `SELECT sku FROM ${TABLE} JOIN 'main'.'chunks'`,
    `SELECT sku FROM ${TABLE}, sqlite_master`,
    `SELECT sku FROM ${TABLE}, sqlite_schema`,
    `SELECT sku FROM ${TABLE}, pragma_table_list`,
    `SELECT sku FROM ${TABLE}, pragma_table_list()`,
    `SELECT sku FROM ${TABLE}, dbstat`,
    `SELECT (SELECT count(*) FROM artifacts) FROM ${TABLE}`,
    `SELECT sku FROM ${TABLE} WHERE EXISTS (SELECT 1 FROM tables)`,
    `SELECT sku FROM ${TABLE} UNION SELECT id FROM tables`,
    `SELECT sku FROM ${TABLE} JOIN other_fedcba9876543210`,
    // A physical table projected after the schema was read is still refused by its shape.
    `SELECT sku FROM ${TABLE} JOIN later_aaaaaaaaaaaaaaaa`,
    `SELECT sku FROM ${TABLE} WHERE sku = 'chunks'`,
  ])('refuses %s', (sql) => refuses(sql));

  it('refuses a name differing only by case', () => {
    refuses(`SELECT sku FROM ${TABLE}, RUNTIME_TOKENS`);
    refuses(`SELECT sku FROM ${TABLE}, "Runtime_Tokens"`);
  });
});

describe('row sources', () => {
  it.each([
    // A name never declared, in a row-source position.
    `SELECT sku FROM ${TABLE}, nowhere`,
    `SELECT sku FROM nowhere`,
    // A declared alias is not a row source; only a common table expression is.
    `SELECT 1 AS spare FROM ${TABLE}, spare`,
    // A table-valued function remotely.
    `SELECT value FROM ${TABLE}, json_each(sku)`,
    // Schema qualification of the allowed table itself.
    `SELECT sku FROM main.${TABLE}`,
    // `window` after a row source is an alias, not a WINDOW clause, so the comma after it
    // still introduces a row source. Uses a name outside the schema, so only the row-source
    // rule can refuse it.
    `SELECT sku FROM ${TABLE} window, nowhere`,
    `SELECT sku FROM ${TABLE} t window, nowhere`,
    // A CTE is scoped to the query that declares it, as SQLite scopes it.
    `SELECT sku FROM (WITH zz AS (SELECT sku FROM ${TABLE}) SELECT sku FROM zz) AS q, zz`,
    // A CTE column list may hold only names; a subquery there would escape the walk.
    `WITH x((SELECT count(*) FROM ${TABLE})) AS (SELECT 1) SELECT 1 FROM x`,
  ])('refuses %s', (sql) => refuses(sql));

  it('allows a table-valued JSON function locally, where the deadline bounds it', () => {
    expect(() => guard(`SELECT j.value FROM ${TABLE}, json_each(sku) AS j`, 'local')).not.toThrow();
  });
});

describe('calls and qualifiers', () => {
  it.each([
    `SELECT load_extension('x') FROM ${TABLE}`,
    `SELECT sqlite_version() FROM ${TABLE}`,
    `SELECT random() FROM ${TABLE}`,
    // A declared name called as a function.
    `SELECT 1 AS generate_series FROM ${TABLE} WHERE generate_series(1, 10)`,
    `SELECT "count"(*) FROM ${TABLE} WHERE "readfile"('x')`,
    // A qualifier that is neither the table nor a declared alias.
    `SELECT ghost.sku FROM ${TABLE}`,
    `SELECT 'x'.sku FROM ${TABLE}`,
  ])('refuses %s', (sql) => refuses(sql));
});

describe('shape', () => {
  it.each([
    `SELECT sku FROM ${TABLE}) UNION SELECT id FROM (SELECT 1`,
    `SELECT sku FROM (${TABLE}`,
    `SELECT sku FROM ${TABLE} /*`,
    `SELECT sku FROM ${TABLE} WHERE sku = 'open`,
    `SELECT sku FROM ${TABLE}; SELECT 1`,
    `SELECT sku FROM ${TABLE} WHERE sku = ?`,
    `SELECT sku FROM ${TABLE} WHERE sku = :name`,
    `SELECT sku FROM ${TABLE} WHERE sku = @name`,
    `SELECT sku FROM ${TABLE} WHERE sku = $name`,
    `SELECT sku FROM ${TABLE} WHERE sku = 1_000`,
    `SELECT sku FROM ${TABLE} WHERE sku = 0x1g`,
    `SELECT sku FROM ${TABLE} WHERE région = 1`,
    `INSERT INTO ${TABLE} (sku) VALUES (1)`,
    `WITH x AS (SELECT sku FROM ${TABLE}) DELETE FROM ${TABLE}`,
    `SELECT sku FROM ${TABLE} WHERE sku IN (${'('.repeat(40)}1${')'.repeat(40)})`,
  ])('refuses %s', (sql) => refuses(sql));

  it('refuses a statement over the size bound', () => {
    refuses(`SELECT sku FROM ${TABLE} WHERE sku = '${'x'.repeat(QUERY_GUARD_LIMITS.maxBytes)}'`);
  });

  it('reads a backslash as an ordinary character, as SQLite does', () => {
    // If `\'` were taken as an escape, the subquery would look like it was inside a string.
    refuses(`SELECT '\\', (SELECT count(*) FROM chunks), '\\' FROM ${TABLE}`);
  });

  it('removes comments so nothing can swallow the result wrapper', () => {
    const sql = guard(`SELECT sku FROM ${TABLE} -- trailing`);
    expect(sql).not.toContain('--');
    expect(guard(`SELECT /* inline */ sku FROM ${TABLE}`)).not.toContain('/*');
  });

  it('gives every refusal the same message, whatever the reason', () => {
    const messages = new Set<string>();
    for (const sql of [
      `SELECT sku FROM ${TABLE}, runtime_tokens`,
      `SELECT sku FROM ${TABLE}, nowhere`,
      `SELECT load_extension('x') FROM ${TABLE}`,
      `SELECT sku FROM ${TABLE} WHERE sku = ?`,
    ]) {
      try {
        guard(sql);
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    expect(messages.size).toBe(1);
    expect([...messages][0]).not.toMatch(/runtime_tokens|nowhere|sqlite/);
  });
});

describe('columns', () => {
  it('refuses a column spelled like another object rather than trusting it', () => {
    expect(() => guard(`SELECT chunks FROM ${TABLE}`, 'remote')).toThrow(
      expect.objectContaining(REFUSED),
    );
  });
});

describe('cost, remotely', () => {
  it.each([
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i FROM n`,
    `SELECT sum(list_price) OVER (ORDER BY sku) AS running FROM ${TABLE}`,
    `SELECT count(*) FILTER (WHERE sku > 0) OVER () AS c FROM ${TABLE}`,
    `SELECT a.sku FROM ${TABLE} a, ${TABLE} b, ${TABLE} c, ${TABLE} d`,
  ])('refuses %s', (sql) => refuses(sql, 'remote'));

  it('allows the same statements locally, where the 5 second kill bounds them', () => {
    expect(() =>
      guard(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT i FROM n`,
        'local',
      ),
    ).not.toThrow();
    expect(() =>
      guard(`SELECT sum(list_price) OVER (ORDER BY sku) AS running FROM ${TABLE}`, 'local'),
    ).not.toThrow();
  });

  it('counts references at every depth toward one bound', () => {
    // Two references inside a subquery and one outside: 2,000 cubed, though no single FROM
    // clause names the table more than twice.
    expect(() =>
      guard(`SELECT (SELECT count(*) FROM ${TABLE} a, ${TABLE} b) AS n FROM ${TABLE} c`, 'remote', {
        rowCount: 2_000,
      }),
    ).toThrow(expect.objectContaining(REFUSED));
  });

  it('does not mistake IS DISTINCT FROM for a FROM clause', () => {
    expect(() =>
      guard(
        `SELECT a.sku FROM ${TABLE} a JOIN ${TABLE} b ON a.region IS NOT DISTINCT FROM b.region JOIN ${TABLE} c ON 1`,
        'remote',
        { rowCount: 2_000 },
      ),
    ).toThrow(expect.objectContaining(REFUSED));
  });

  // A name or string that spells `distinct` is not the DISTINCT keyword, so the FROM after it
  // is a real clause whose sources are checked and counted (#556).
  const DISTINCT_SPELLINGS = [
    '[distinct]',
    '"distinct"',
    '`distinct`',
    "'distinct'",
    '[DisTinct]',
    '"DISTINCT"',
  ];

  describe.each(DISTINCT_SPELLINGS)('after an alias spelled %s', (alias) => {
    it.each([
      `SELECT count(*) AS ${alias} FROM ${TABLE} a, ${TABLE} b, ${TABLE} c, ${TABLE} d`,
      `SELECT 1 AS ${alias} FROM json_each`,
      `SELECT 1 AS ${alias} FROM ${TABLE}, json_each`,
      `SELECT 1 AS ${alias} FROM generate_series`,
      `SELECT 1 ${alias} FROM ${TABLE}, nowhere`,
    ])('refuses %s remotely', (sql) => refuses(sql, 'remote'));

    it.each([
      `SELECT 1 AS ${alias} FROM generate_series`,
      `SELECT 1 AS ${alias} FROM ${TABLE}, nowhere`,
    ])('refuses %s locally', (sql) => refuses(sql, 'local'));

    it('still counts every reference toward the join bound', () => {
      expect(() =>
        guard(`SELECT count(*) AS ${alias} FROM ${TABLE} a, ${TABLE} b, ${TABLE} c`, 'remote', {
          rowCount: 2_000,
        }),
      ).toThrow(expect.objectContaining(REFUSED));
    });
  });

  it('treats only IS [NOT] DISTINCT as the comparison', () => {
    // DISTINCT without IS before FROM is not the operator, whatever the spelling.
    refuses(`SELECT x distinct FROM ${TABLE}, nowhere`, 'remote');
    refuses(`SELECT 1 IS NOT 'distinct' FROM ${TABLE}, nowhere`, 'remote');
    refuses(`SELECT 1 IS [distinct] FROM ${TABLE}, nowhere`, 'remote');
  });

  it('bounds a self-join by the rows it would multiply', () => {
    const rows = { rowCount: 2_000 };
    // 2,000 squared is 4e6, inside the bound; cubed is 8e9, far outside it.
    expect(() =>
      guard(`SELECT a.sku FROM ${TABLE} a JOIN ${TABLE} b ON a.sku = b.sku`, 'remote', rows),
    ).not.toThrow();
    expect(() =>
      guard(
        `SELECT a.sku FROM ${TABLE} a JOIN ${TABLE} b ON a.sku = b.sku JOIN ${TABLE} c ON 1`,
        'remote',
        rows,
      ),
    ).toThrow(expect.objectContaining(REFUSED));
  });
});

describe('ordinary SQL a model writes', () => {
  it.each([
    `SELECT sku, list_price FROM ${TABLE} WHERE list_price > 10 ORDER BY sku LIMIT 5`,
    `SELECT region, count(*) AS n FROM ${TABLE} GROUP BY region HAVING count(*) > 1`,
    `SELECT region, count(*) n FROM ${TABLE} GROUP BY region`,
    `SELECT ${TABLE}.* FROM ${TABLE}`,
    `SELECT p.sku FROM ${TABLE} p WHERE p.list_price IS NOT NULL`,
    `SELECT p.sku FROM ${TABLE} AS p`,
    `WITH cheap AS (SELECT sku FROM ${TABLE} WHERE list_price < 5) SELECT sku FROM cheap`,
    `WITH cheap(code) AS (SELECT sku FROM ${TABLE}) SELECT code FROM cheap`,
    `WITH a AS (SELECT sku FROM ${TABLE}), b AS (SELECT sku FROM a) SELECT sku FROM b`,
    `SELECT sku FROM ${TABLE} WHERE sku IN (SELECT sku FROM ${TABLE} WHERE region = 'eu')`,
    `SELECT sku FROM ${TABLE} WHERE sku IN ('a', 'b')`,
    `SELECT sku, row_number() OVER (ORDER BY list_price DESC) AS position FROM ${TABLE}`,
    `SELECT sku, rank() OVER w AS r FROM ${TABLE} WINDOW w AS (ORDER BY list_price), v AS (PARTITION BY region)`,
    `SELECT CAST(list_price AS INTEGER) AS whole FROM ${TABLE}`,
    `SELECT sku FROM ${TABLE} ORDER BY sku COLLATE NOCASE`,
    `SELECT sku FROM ${TABLE} UNION ALL SELECT sku FROM ${TABLE}`,
    `SELECT sku, 'it''s' AS note FROM ${TABLE}`,
    `SELECT sku FROM ${TABLE} WHERE region = 'café'`,
    `SELECT CASE WHEN list_price > 10 THEN 'high' ELSE 'low' END AS band FROM ${TABLE}`,
    `SELECT sku FROM (SELECT sku FROM ${TABLE}) AS inner_rows`,
    `SELECT sku FROM ${TABLE} WHERE list_price BETWEEN 1 AND 2.5e1`,
    `SELECT json_extract(sku, '$.a') AS a FROM ${TABLE}`,
    `SELECT sku FROM ${TABLE};`,
    `SELECT sku FROM ${TABLE} WHERE region IS NOT DISTINCT FROM 'eu'`,
    `SELECT sku FROM ${TABLE} WHERE region IS DISTINCT FROM 'eu'`,
    `SELECT sku FROM ${TABLE} WHERE region is not Distinct from sku`,
    `SELECT region IS DISTINCT FROM 'eu' AS changed FROM ${TABLE}`,
    `SELECT count(*) AS [distinct] FROM ${TABLE}`,
    `SELECT sku AS "distinct" FROM ${TABLE} a, ${TABLE} b`,
    `SELECT window.sku FROM ${TABLE} window`,
    `VALUES (1), (2)`,
  ])('answers %s', (sql) => {
    expect(() => guard(sql, 'remote')).not.toThrow();
    expect(() => guard(sql, 'local')).not.toThrow();
  });
});

describe('the lexer', () => {
  it('unescapes doubled quotes and lowercases in ASCII only', () => {
    const tokens = lexSql(`SELECT "A""b", 'C''d', [E f], \`G\`\`h\``);
    expect(tokens.filter((token) => token.kind === 'quoted').map((token) => token.value)).toEqual([
      'a"b',
      'e f',
      'g`h',
    ]);
    expect(tokens.find((token) => token.kind === 'string')?.value).toBe("c'd");
  });
});
