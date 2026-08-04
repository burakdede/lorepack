# SQL parser bake-off

The evidence behind [`adr-sql-surface.md`](../../docs/architecture/adr-sql-surface.md), which
chose a tokenizer of our own over `node-sql-parser` and `sql-parser-cst`.

`parser-bakeoff.mjs` runs `node-sql-parser` against a set of hostile and legitimate queries and
prints how each is classified. It is kept because the ADR cites its output, and because the
decision should be re-runnable rather than taken on trust.

```bash
mkdir /tmp/bakeoff && cd /tmp/bakeoff
npm init -y && npm i node-sql-parser@5.4.0
node <path-to-lorepack>/benchmarks/sql/parser-bakeoff.mjs
```

It is deliberately **not** part of `pnpm test`: neither library is a dependency of Lorepack,
and adding 89 MB to the lockfile to keep a decision reproducible would be the wrong trade.

## What it shows

- Every write, DDL and multi-statement case is visible to the parser, as expected.
- `SELECT row_number() OVER (ORDER BY c)` **fails to parse**, which is the finding that decided
  it: failing closed on a legitimate analytic query is correct behaviour and a bad outcome.
- The hostile cases marked "accepted as single select" are genuinely single SELECTs
  (`sqlite_master`, `readfile`, a recursive CTE). No statement-level parser can reject them,
  which is the argument for the authorizer being the control rather than the second opinion.

## The two measurements that are not in this script

Both are in the ADR and both were run against a real database:

1. `db.limits.vdbeOp = 250_000` does not bound a runaway recursive CTE. It ran past 60 seconds.
2. `worker.terminate()` does not return while the thread is inside a synchronous SQLite call.
   A terminate request had still not resolved 20 seconds later.

Together they are why the executor is a child process that gets `SIGKILL`.
