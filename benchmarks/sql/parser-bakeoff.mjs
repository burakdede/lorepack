import pkg from 'node-sql-parser';

const { Parser } = pkg;
const p = new Parser();
const opt = { database: 'sqlite' };

// Queries a model might author, and queries an attacker would.
const HOSTILE = [
  ['stacked', 'SELECT 1; DROP TABLE artifacts'],
  ['stacked via comment', 'SELECT 1 -- \n; DROP TABLE artifacts'],
  ['block comment hide', 'SELECT 1 /* ; DROP TABLE artifacts */'],
  ['comment then stack', '/* x */ SELECT 1; /* y */ DELETE FROM artifacts'],
  ['pragma', 'PRAGMA table_info(artifacts)'],
  ['attach', "ATTACH DATABASE '/etc/passwd' AS x"],
  ['insert', 'INSERT INTO t VALUES (1)'],
  ['update', 'UPDATE t SET a = 1'],
  ['delete', 'DELETE FROM t'],
  ['create', 'CREATE TABLE x (a)'],
  ['drop', 'DROP TABLE x'],
  ['load_extension', "SELECT load_extension('/tmp/evil.so')"],
  ['readfile', "SELECT readfile('/etc/passwd')"],
  ['writefile', "SELECT writefile('/tmp/x','y')"],
  ['catalog peek', 'SELECT * FROM sqlite_master'],
  ['union catalog', 'SELECT 1 UNION SELECT sql FROM sqlite_master'],
  [
    'recursive bomb',
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT * FROM c',
  ],
  ['select in cte then insert', 'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x'],
  ['trailing semicolon only', 'SELECT 1;'],
  ['unicode ws', 'SELECT 1'],
  ['nested quotes', `SELECT 'a''; DROP TABLE t; --'`],
  ['dq identifier', 'SELECT "col; DROP TABLE t" FROM t'],
];
const LEGIT = [
  ['plain', 'SELECT * FROM t_orders_abc LIMIT 10'],
  [
    'aggregate',
    'SELECT c_0_region, sum(c_1_units) AS total FROM t_x GROUP BY c_0_region ORDER BY total DESC',
  ],
  ['cte', 'WITH top AS (SELECT * FROM t_x LIMIT 5) SELECT * FROM top'],
  ['join', 'SELECT a.c_0, b.c_1 FROM t_a a JOIN t_b b ON a.c_0 = b.c_0'],
  ['case', "SELECT CASE WHEN c_0 > 1 THEN 'y' ELSE 'n' END FROM t_a"],
  ['window', 'SELECT c_0, row_number() OVER (ORDER BY c_1) FROM t_a'],
  ['sqlite cast', 'SELECT CAST(c_0 AS INTEGER) FROM t_a'],
  ['glob', "SELECT * FROM t_a WHERE c_0 GLOB 'x*'"],
  ['json1', "SELECT json_extract(c_0, '$.a') FROM t_a"],
  ['limit offset', 'SELECT * FROM t_a LIMIT 5 OFFSET 10'],
];

const classify = (sql) => {
  try {
    const ast = p.astify(sql, opt);
    const list = Array.isArray(ast) ? ast : [ast];
    return { ok: true, count: list.length, types: list.map((a) => a.type).join(',') };
  } catch (e) {
    return { ok: false, error: String(e.message).split('\n')[0].slice(0, 60) };
  }
};

console.log('--- HOSTILE (want: rejected, or parsed as >1 statement / non-select) ---');
for (const [name, sql] of HOSTILE) {
  const r = classify(sql);
  const verdict = r.ok
    ? r.count > 1 || r.types !== 'select'
      ? 'VISIBLE ' + r.types + ' x' + r.count
      : '*** ACCEPTED AS SINGLE SELECT ***'
    : 'rejected';
  console.log(String(name).padEnd(24), verdict);
}
console.log('\n--- LEGITIMATE (want: parsed as one select) ---');
for (const [name, sql] of LEGIT) {
  const r = classify(sql);
  console.log(
    String(name).padEnd(24),
    r.ok ? `ok ${r.types} x${r.count}` : `*** REJECTED: ${r.error}`,
  );
}
