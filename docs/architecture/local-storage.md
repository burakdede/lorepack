# Local build storage

Three pieces sit under `.lore/`: immutable build directories, content-addressed objects,
and one mutable state database. The split is the architecture's central invariant made
physical: a sealed build never changes, and everything that does change lives elsewhere.

```text
.lore/
  builds/lore_<sha256>/     immutable, opened read-only forever
    context.sqlite
    manifest.json
    objects/
    reports/
  cache/                    disposable, deleting it changes only rebuild time
  tmp/                      candidate builds, never mistaken for real ones
  state.sqlite              the only mutable database
  lock/                     cross-process build and activation lock
```

## Atomic directories

A candidate build is created under `.lore/tmp/`, not under `builds/`. An interrupted build
therefore leaves a directory that no reader will ever consider valid, rather than a
half-written build that looks real.

Sealing is `fsync` the candidate, `rename` into `builds/`, `fsync` the parent. Rename
within a filesystem is atomic, which is why `tmp/` lives inside `.lore/` rather than in
the system temp directory: a cross-device rename would degrade to a copy and lose the
guarantee.

Sealing an id that already exists is a no-op rather than an error. Build ids are content
derived, so an identical id means identical logical content, and the existing directory is
already correct.

Directory `fsync` is a POSIX guarantee with no Windows equivalent, so that call is best
effort. What we actually depend on, atomic same-volume rename, holds on both.

## Object store

Content-addressed with two levels of fan-out (`objects/sha256/ab/cd/<rest>`), so no
directory grows unmanageable.

Reads verify the digest. A mismatch raises `LORE_E_OBJECT_CORRUPT` naming the hash rather
than returning wrong bytes, and `quarantine` removes the object so the next build
regenerates it instead of failing identically forever. Writing content that already exists
verifies rather than trusts, which is what makes an interrupted build cheap to resume.

## State store and activation

`state.sqlite` holds build history, the active pointer, and operational receipts.

Activation is one transaction: the pointer moves and a monotonic generation increments
together. A crash leaves the old pointer, never a torn state. The generation never repeats,
including after a rollback, so a reader detects a change by comparing one integer rather
than by watching the filesystem.

Only a verified build can be activated. Attempting to activate a failed candidate raises
`LORE_E_BUILD_VALIDATION` and leaves the pointer untouched, which is the mechanism behind
"a failed build can never corrupt the active version".

## Request-scoped build handles

`LocalActiveBuildProvider` hands out reference-counted read-only handles.

```ts
const handle = await provider.acquire();   // start of a request
try {
  // every read for this request uses handle's database
} finally {
  handle.release();                        // end of a request
}
```

The contract from architecture section 15.2:

1. A request in flight finishes against the build it captured.
2. The first request after the pointer moves observes the new generation and opens the new
   build.
3. No single response can mix rows from two builds.
4. An old database closes only after its final in-flight request releases it.
5. A missed filesystem notification is harmless, because the generation is re-read at each
   request boundary rather than pushed.

Concurrent readers of the same build share one open database. The currently active build
stays open when its refcount reaches zero, since reopening it for the next request would
cost without benefit; older builds close as soon as they drain.

## Project lock

Builds and activation serialise on `.lore/lock`, created with `mkdir`, which is atomic
everywhere we support. The record inside names the owning pid and when it was taken.

A lock is reclaimed when its owner is no longer running, or when it is older than the
staleness window. A lock held by a live, recent process is never reclaimed: the caller
waits and then fails with `LORE_E_LOCK_HELD` naming the pid and how to recover.

Two deliberate details. The owner pid is injectable, so the reclamation paths can be tested
as a genuinely different process rather than approximated. The wait deadline uses wall
time even when a test injects a clock for staleness, because a frozen clock must never turn
the wait loop into a hang.

### Why not `proper-lockfile`

Architecture section 8.2 allows "`proper-lockfile` or an equivalent narrow lock". The
dependency has had no release since 2022, and the equivalent is under a hundred lines with
cross-platform tests we own. Given the choice between a dormant dependency in the critical
path of build correctness and a small tested implementation, the implementation wins. It is
isolated in one module, so the decision is reversible without touching build or activation
code.

## Typed tables

Structured sources become real SQL tables inside the sealed build, plus a catalog that maps a
stable Lore table id to the generated physical name. Migration `0002_tables.sql` adds `tables`
and `table_columns`; the physical tables themselves are created at import time, so they cannot
appear in a migration.

### No identifier from user content ever reaches SQL

A spreadsheet may have a sheet called `"; DROP TABLE artifacts; --` and a column called the
same. The defence is not escaping. It is that **user text is never an identifier at all**:

1. The display name is slugged to `[a-z0-9_]`, losing whatever it has to.
2. Identity comes from a hash of the *table id*, not from the slug, so two sheets that slug
   identically still get different tables.
3. Every name passes `assertIdentifier` immediately before it is interpolated, into DDL or a
   query. That check can only fail if an earlier invariant broke, which is exactly why it is
   worth keeping: the day someone adds a second name generator and forgets to slug it, it
   throws instead of executing what they passed.

So `Q3 Report` becomes `t_q3_report_8f2a91cc04e1` and the hostile name above becomes
`t_drop_table_artifacts_a41f...`. Source names survive in the catalog for display, and
`describeTable` relabels rows back to them on the way out, so a reader sees `Postal Code` while
the query used `c_2_postal_code`.

Names are derived from the artifact path, so they are identical on every machine and every
rebuild. That determinism is load-bearing: the names are written into the build database, and a
name that varied by host would make identical projects produce different bytes.

### Import

Everything happens inside `writeCatalog`'s transaction rather than one of its own. A build
database is complete or it is discarded, so a failure part-way through an import rolls back the
**whole build**, not just the offending table. There is no state in which a half-filled table
is servable.

Inserts are batched by **cells, not rows**. Rows is the natural unit and the wrong one: 500 rows
is 1,000 bound values in a two-column table and 50,000 in a hundred-column one, and the second
is close enough to the argument limit to fail on someone's real spreadsheet. A fixed cell budget
makes the statement the same size whatever the table's shape.

### Types

SQLite storage classes, chosen to match D1 so Phase 6 is a projection rather than a redesign.
`boolean` is stored as `INTEGER` because `node:sqlite` binds no boolean and a `STRICT` table
needs a declared class. `date` is stored as ISO **text**: neither SQLite nor D1 has a date type,
and an epoch integer would need a timezone the source never stated. ISO text sorts correctly as
text, which is the point of ISO.

### Reading

`listTables` and `describeTable` are served from the catalog, with per-column statistics (null
count, distinct estimate, min and max) recorded at import so a description costs no scan. The
distinct count is exact below 10,000 values and a floor above it, and which of the two applies
is a stored flag rather than something the caller has to guess.

A description reports **both names** for the table and for every column: the one the source
file used, and the generated `sqlName` a query has to address. That is what makes it sufficient
on its own, and it was not true until #235: the description returned the source names, the
query surface accepted only the generated ones, and the rejection message sent a caller back to
the description. The capability was shipped and unreachable through any documented output.

**Values are reported as the type the description declared, not as the class they are stored
in.** A `boolean` column reads `true`, `false` and `null`, in the sample and in query results,
even though it is held as `INTEGER`; `min` and `max` come back as numbers for a numeric column,
even though they are held as text. The storage decisions above are right, and reporting them to
a caller who was told the column is `boolean` would be giving two answers to one question.

Decoding follows renaming: a query result column that can be matched to a catalog column is
renamed *and* decoded, and an aliased or computed one is neither. One rule degrades
predictably; two eventually disagree.

The read-only authorizer is widened per build with that build's physical table names, read from
the catalog and re-validated on the way out. It cannot be a static list, because the names
depend on which files the build contains.

### The locator, and where it lives

Every part of a table's locator is a column on `tables`: `relative_path`, `sheet`, `line_start`,
`line_end`, and `cell_range`. The last was added by #235, and the reason it is a column rather
than a lookup into the parser-defined `metadata` blob is that a locator is a typed first-class
concept: architecture section 10.8 requires a queried row to trace back to a sheet and a cell
range, and that should not depend on a key one parser happens to write.

`describeTable` and `queryTable` build it with the same function. They built it separately
before, and disagreed exactly as that arrangement invites: `queryTable` reported the sheet and
`describeTable` did not, so two responses about one table from one build named different places.

### Schema versions, and why an old build is refused

**A sealed build is never migrated.** Migrations run only against a writable database, and a
build is opened read-only, so a build carries the schema it was written at forever.

Opening one therefore checks it, against the migration files this binary ships rather than
against a hand-kept number. A build older or newer than the code reading it is refused with
`LORE_E_SCHEMA_MISMATCH` and told to run `lore build`. Without the check the first symptom is
whatever statement happens to name a column that does not exist yet, from inside a query, with
nothing to connect it to the cause.

### Querying a table

`queryTable` accepts **one read-only SELECT** over **one table**, and everything about it is
designed on the assumption that the SQL was written by a model that may have been talked into
writing something else. The decisions and the measurements behind them are in
[`adr-sql-surface.md`](./adr-sql-surface.md); this is what the surface does.

**Statement shape** is checked by a tokenizer, not a SQL parser. It answers one question, is
this exactly one statement beginning as a SELECT, and refuses everything else with a sentence
about the rule. Comments cannot hide a second statement, because comments are removed before
the semicolons are counted, and a semicolon inside a string or a quoted identifier is text.

**Everything else is the authorizer**, installed on a fresh read-only connection and scoped
**per query** to the physical table being queried. So a query cannot read another table in the
same build, cannot read the catalog that would tell it those tables exist, and cannot call a
function outside a curated allowlist. This is the control; the tokenizer is not.

**The deadline is enforced by killing a process.** A query runs in a forked child, and past
five seconds it gets `SIGKILL`. Both cheaper options were measured and neither works: the
`vdbeOp` limit does not bound a runaway recursive CTE, and `worker.terminate()` does not return
while a thread sits inside a synchronous SQLite call.

**Results are bounded and say so.** A limit is applied by wrapping the statement rather than
appending to it, so a compound `SELECT ... UNION SELECT ...` is bounded as a whole. Truncation
is reported, never silent, and a response too large to serialize is refused with its size
rather than trimmed. Every result carries the table's locator, including sheet and cell range.

**Errors say what rule was broken and nothing about the machine.** SQLite words a denial as
`access to t_secrets_f13bc4051aa0.c_0_sku is prohibited`, which names something the caller was
not allowed to see, so the message is replaced rather than wrapped. No path, no schema, no
other project.

`describeTable` is the required first step, not merely the preferred one. Table and column
names are generated, so a query written against the source's names does not run, and the
`sqlName` fields a description returns are the only place those generated names appear.
