# ADR: how Lorepack validates model-authored SQL

**Status**: accepted, 2026-08-05. Resolves the parser question in #77.

**Decision**: validate statement *shape* with **a SQLite-aware tokenizer of our own**, and
leave every question about *meaning* to the SQLite authorizer. Do not adopt `node-sql-parser`,
and do not adopt `sql-parser-cst`.

The reality check on #77 named those two candidates. This supersedes that line.

## What the layers are actually for

Section 19.5 asks for defence in depth, and #77 adds the criterion that the security tests must
pass **with the AST validator disabled**. That criterion is the whole design, read carefully:
the authorizer is the control, and the validator in front of it exists to answer one question
the authorizer cannot see, because the authorizer runs per *operation* and not per *statement*:

> Is this input exactly one statement, and does it begin as a `SELECT`?

Everything else, which tables may be read, which functions may be called, whether a write is
attempted, is a question about meaning, and the authorizer answers all of them at the engine
boundary where nothing can be fooled by clever text.

A general SQL parser answers the shape question, and also builds a grammar-level understanding
of a query we then do not use. That extra understanding is not free: it is a second opinion
about what the SQL means, and where it disagrees with SQLite the disagreement is the bug.

## What was measured

Both candidates installed and run, 2026-08-05, against a fixture set of hostile and legitimate
queries (`benchmarks/sql/`).

| | node-sql-parser 5.4.0 | sql-parser-cst 0.42.1 | **own tokenizer** |
|---|---|---|---|
| Licence | Apache-2.0 | **GPL-2.0-or-later** | n/a |
| Installed size | **89 MB** | 7.5 MB | 0 |
| Dependencies | 2 | 0 | 0 |
| Last release | 2026-01-12 | 2026-06-02 | n/a |
| Sees stacked statements | yes | yes | **yes** |
| Sees statements hidden after a comment | yes | yes | **yes** |
| Accepts a window function | **no** | yes | **yes** |

Two findings decided it.

**`sql-parser-cst` is GPL-2.0-or-later.** Lorepack is Apache-2.0. Linking a copyleft library
into the distributed product is a licence incompatibility, not a preference, and no technical
merit can outweigh it. It was disqualified before its behaviour mattered.

**`node-sql-parser` cannot parse `row_number() OVER (ORDER BY c_1)`.** It fails with
`Expected "#", "--", "/*", "PARTITION", ...`. Failing closed on a legitimate analytic query is
the correct behaviour for a validator and a bad outcome for a user: window functions are
exactly what someone reaches for when querying a spreadsheet. This is the concrete form of the
risk the reality check predicted, that a multi-dialect parser has undocumented SQLite gaps. It
also costs 89 MB, which is two and a half times the heaviest thing already in the tree.

## Why a tokenizer is the stronger control here, not the weaker one

It is worth stating plainly, because "we wrote our own" usually reads as a downgrade.

A tokenizer has **no grammar to be wrong about**. It walks the input character by character,
tracking exactly four things: single-quoted strings (with `''` escapes), double-quoted,
bracketed and backticked identifiers, `--` comments, and `/* */` comments. Outside all of
those, a `;` is a statement separator and the first word is the statement's keyword. That is a
complete and decidable answer to the shape question, in about a hundred lines.

The comment cases #77 asks for by name fall out of it rather than being special-cased:
`SELECT 1 -- \n; DROP TABLE artifacts` has two statements because the newline ends the comment,
and `SELECT 1 /* ; DROP TABLE artifacts */` has one because the `;` is inside the block.

It also cannot reject what it does not understand, because it does not try to understand
anything. Window functions, `json_extract`, `GLOB`, recursive CTEs and whatever SQLite adds
next all pass the shape check and are judged by the authorizer on what they actually do.

## The deadline is not optional, and this was measured

`db.limits.vdbeOp = 250_000` reads back correctly and does **not** bound a runaway query.
Measured 2026-08-05:

```
WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c
```

still ran after **60 seconds** and had to be killed. `node:sqlite` is synchronous, so that
query holds the event loop and no HTTP or MCP request is served while it runs.

So the query has to run somewhere else. Section 19.5 says a worker thread. **That does not
work**, and this is the second measurement:

> `worker.terminate()` **does not return** while the thread is inside a synchronous native
> SQLite call. A terminate request on a thread running the query above had still not resolved
> twenty seconds later.

V8 cannot interrupt native code, so a thread running a runaway query is unkillable for as long
as the query runs. A deadline that cannot stop the work is not a deadline.

**So the executor is a child process, not a worker thread.** `SIGKILL` comes from the operating
system and is not subject to any of this. The kill is issued and deliberately **not awaited**:
waiting on the exit of a process being killed would reintroduce the same hang.

The cost is startup, tens of milliseconds against a five-second deadline, and it buys a
guarantee rather than an intention. This supersedes the "worker-thread executor" wording in
section 19.5, for the reason measured above rather than by preference.

## The authorizer, and the one thing it gets wrong by default

Denying every `SQLITE_READ` outside the allowlist also denies **common table expressions**,
which is a surprise worth writing down. A recursive CTE issues `SQLITE_READ` for its *own*
name, so `WITH x AS (...) SELECT * FROM x` fails with an authorization error even though it
reads nothing it should not.

The discriminator is the fourth argument, the database name: a real table reports `main`, and a
CTE reports `null`, because there is no database behind it. Allowing the null case is safe
rather than a hole, since whatever the CTE is built from was itself authorized, with `main`,
before this.

Two more findings from the same suite:

- SQLite words a denial as `access to t_secrets_f13bc4051aa0.c_0_sku is prohibited`, which
  names the physical table and column of something the caller was not allowed to see. The
  message is **replaced**, not wrapped: the error text was itself the disclosure.
- Functions are an **allowlist**, not a denylist. `load_extension` is the one everybody
  remembers, and it is already impossible via `allowExtension: false`; the allowlist is what
  covers the next one. `random()` is excluded for a second reason: a query returning different
  rows on each run cannot be cited, and every result here carries provenance.

## What this does not change

Every connection-level control from section 19.5 stays exactly as specified and was already in
place before this ticket: `readOnly`, `allowExtension: false`,
`enableDoubleQuotedStringLiterals: false`, defensive mode on, and the full `db.limits.*` set
applied and read back to confirm SQLite did not silently clamp them.

## Re-check

If SQLite gains a statement-shape API, or a maintained, permissively licensed, SQLite-specific
parser appears that accepts everything SQLite accepts, this is worth revisiting. The tokenizer
is small enough that replacing it is cheap; that is part of why it was chosen.
