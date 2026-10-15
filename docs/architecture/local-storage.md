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
  lock.reclaimed-*/         tombstones of reclaimed locks, removed after an hour
```

Archive collection contracts use real filesystem fixtures in
[`archive.test.ts`](../../packages/backend-local/test/archive.test.ts). They check stable
member ordering and exact binary bytes, reject missing or changed addressed objects,
and refuse an original source changed to a directory, removed or edited after its hash
was recorded. Refused collection leaves the current source bytes untouched.

Local retention contracts in
[`activate.test.ts`](../../packages/cli/test/activate.test.ts) use real compiled builds and
runtime references. They verify the default five-build window with tied timestamps and
failed attempts, candidate-object protection during cleanup, and reader explanations from
active requests through an idle cached catalog to backend shutdown.

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

A build killed before it seals leaves its candidate behind. Every build sweeps
`tmp/candidate-*` as soon as it holds the project lock, which is safe because a build holds
the lock from creating its candidate until sealing it, so under the lock no candidate belongs
to a running build (#572). Before the sweep, these survived every later build and prune.

`.lore` itself must be inside the project. A repository can ship it as a symbolic link, and
every write would then land wherever it points, so loading the configuration refuses a `.lore`
that resolves outside the project with `LORE_E_PATH_ESCAPE`, and `lorepack doctor` fails its
build-directory check. A link that stays inside the project is allowed. The decision to
refuse even user-owned external targets is recorded in
[ADR 0003](../adr/0003-project-contained-build-storage.md).

Directory `fsync` is a POSIX guarantee with no Windows equivalent, so that call is best
effort. What we actually depend on, atomic same-volume rename, holds on both.

## Object store

`FileObjectStore.verify(hash, signal)` streams the checksum and returns false for a missing
object without creating storage. A checksum mismatch raises `LORE_E_OBJECT_CORRUPT`, naming
the object hash and preserving the corrupt bytes for recovery. An aborted signal propagates
the stream's `AbortError`; retrying without that signal can verify the unchanged object.
Malformed hashes are refused. Verification never quarantines or rewrites data.
[`object_verify.test.ts`](../../packages/backend-local/test/object_verify.test.ts) checks
multi-chunk content, missing/corrupt objects, cancellation and invalid hashes using real files.


Content-addressed with two levels of fan-out (`objects/sha256/ab/cd/<rest>`), so no
directory grows unmanageable. An object is written with `writeFileAtomic`, and every fan-out
directory created for it is then synced into its parent: the build record that references the
object commits with `synchronous = FULL`, so after a power loss the record must not survive a
directory entry that did not (#572).

Reads verify the digest. A mismatch raises `LORE_E_OBJECT_CORRUPT` naming the hash rather
than returning wrong bytes, and `quarantine` removes the object so the next build
regenerates it instead of failing identically forever. Writing content that already exists
verifies rather than trusts, which is what makes an interrupted build cheap to resume.

Because writing existing content is a no-op, a build that reuses an object never re-creates
it. `lorepack prune` therefore decides which objects to delete under the project lock: it
prints a plan computed without the lock, then, holding it, re-reads history and deletes only
the builds and objects that the plan named and that nothing surviving still references
(every directory under `builds/`, the active build and any leftover candidate under
`tmp/`). Build records are forgotten in one transaction before any file is removed (#564).

## State store and activation

`state.sqlite` holds build history, the active pointer, operational receipts, and the
project's corpus and runtime namespace identity.

State migration `0002_runtime-identity.sql` seeds one pair of 128-bit identifiers inside
the existing migration transaction. `corpus_<32 lowercase hex>` names the collection;
`namespace_<32 lowercase hex>` names its local storage/runtime binding. Reopening or
renaming the project preserves both. A fresh state database receives a new pair even
when its content yields the same build digest. Moving or copying the retained state
preserves the pair. A copied runtime still owns its own handles.

Neither identifier enters source bytes, canonical roots, manifests or build hashing.
They are identifiers, not credentials. The local owner's filesystem access is the
trust boundary. Missing or malformed identity records cause `LORE_E_SCHEMA_MISMATCH`;
opening the database does not silently replace them. Restore a known-good state backup.
See [ADR 0005](../adr/0005-corpus-runtime-identity.md) for the identity boundary.

Activation is one transaction: the pointer moves and a monotonic generation increments
together. A crash leaves the old pointer, never a torn state. The generation never repeats,
including after a rollback, so a reader detects a change by comparing one integer rather
than by watching the filesystem.

A new state database is initialized under `.lore/tmp/state-init-*`, including its runtime
identity, and closed before publication. Publication refuses an existing destination;
concurrent first opens therefore read the same completed winner. They never open another
initializer's private database. The private name is removed before its owner opens the
canonical name. Normal failures remove staging; a killed initializer can leave an inert
private directory. See [ADR 0027](../adr/0027-atomic-initial-state.md) for filesystem and
SQLite alias constraints. Existing state is never replaced and keeps the five-second
busy timeout, checksum checks and read-only newer-schema refusal.

Several processes open `state.sqlite` at once by design: `lorepack dev`, MCP sessions, Studio
and one-off commands. Every connection gets its five-second busy timeout from the constructor,
before its first statement, so a writer holding the database makes an open wait rather than
fail; the journal-mode change that opening for writing performs is a write, and it used to run
unprotected (#571). Migrations are decided inside the `BEGIN IMMEDIATE` that applies them, so
when two processes open a new project together one applies `0001` and the other finds it
applied.

Only a verified build can be activated. Attempting to activate a failed candidate raises
`LORE_E_BUILD_VALIDATION` and leaves the pointer untouched, which is the mechanism behind
"a failed build can never corrupt the active version".

## Request-scoped build handles

`LocalActiveBuildProvider` hands out reference-counted read-only handles.
Each handle captures the corpus and namespace. The provider also binds the handle object
to its own open database connection. Another provider's handle, a copied or forged
object, a released handle, or a handle whose connection has closed is refused with
`LORE_E_INVALID_ARGUMENT`, even when the build digest and identity metadata match.
Repeated release is harmless; releasing a closed connection cannot drain a replacement.

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
cost without benefit; older builds close as soon as they drain. A build that drained while
it was active is closed by the first request after the pointer moves, because every
acquisition re-reads the pointer and closes any database no request holds except the active
one (#566). Before that, a long-running `lorepack dev` kept one database open per rebuild, and
a pruned build's file stayed open, its space never freed and, on Windows, undeletable.

If the pointer moves before another request arrives, the previous idle catalog remains
owned by the runtime. Its reader record keeps that build and its objects out of cleanup on
every OS. The next acquisition or runtime shutdown closes the connection and releases that
record, after which a subsequent prune can reclaim it.

## Project lock

Builds, activation and prune serialise on `.lore/lock`, created with `mkdir`, which is atomic
everywhere we support. The record inside names the owning pid, the host it runs on, when that
process started, when the lock was taken and a unique ownership token.

On Windows, directory removal can remain pending until its last handle closes
([Microsoft's directory-removal semantics](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-removedirectoryw)).
An `EPERM` while creating the lock directory is retried within the existing lock wait deadline.
If it persists, the original filesystem error is returned. Parent-directory and owner-record
errors fail immediately; POSIX creation errors keep their existing behavior.

A lock is reclaimed when its owner is no longer running. "No longer running" means the pid is
gone, or the pid is alive but names a process that started at a different time: pids are
reused, and a lock must not outlive its owner because an unrelated process (or pid 1) inherited
the number. The start is compared as clock ticks since boot on Linux, read from `/proc`, and as
wall time from `ps` on macOS and from PowerShell on Windows, within five seconds. When the start
of a live process cannot be read, the lock is kept.

Process probes never search PATH or the project directory. macOS uses `/bin/ps`; Windows
uses `System32/WindowsPowerShell/v1.0/powershell.exe` under an absolute `SystemRoot`.
An unavailable probe keeps the lock rather than running a project-supplied executable.

A lock taken on another host is never reclaimed automatically, whatever its age: its owner's
liveness cannot be checked from here, which matters on NFS and synced folders. The command
fails with `LORE_E_LOCK_HELD` naming the host, and the remedy is to remove `.lore/lock` once
nothing is running there. An unreadable lock record is reclaimed only after the staleness
window. A lock held by a live process is never reclaimed because a build can legitimately run
longer than that window: the caller waits and then fails with `LORE_E_LOCK_HELD` naming the
pid and how to recover. The ownership token also prevents a former holder from removing a
replacement lock during cleanup.

Reclaiming is a rename, not a delete (#565). Deciding a lock is stale and then removing
`.lore/lock` removes whatever is there by then, which can be the lock a second reclaimer has
just taken; eight processes racing for one dead owner's lock had two or three holders in a
third of trials. Instead the stale lock is renamed to `.lore/lock.reclaimed-token-<token>` (or
`-inode-<n>` for an unreadable record), a name derived from the lock that was judged. Only the
first rename can succeed: every later one targets a directory that already exists and is not
empty, which fails on POSIX and Windows alike, so a late reclaimer cannot move the new holder's
lock. Tombstones are removed an hour after they are marked, by whichever process next takes
the lock.

The retention interval bounds protection against a reclaimer suspended between reading and
renaming. A process paused for longer than one hour can outlive its tombstone. See the
[lock reclamation decision](../adr/0002-lock-reclamation.md) for this trade-off.

Two deliberate details. The owner pid is injectable, so the reclamation paths can be tested
as a genuinely different process rather than approximated. The wait deadline uses wall
time even when a test injects a clock for staleness, because a frozen clock must never turn
the wait loop into a hang.

### Why not `proper-lockfile`

Architecture section 8.2 allows "`proper-lockfile` or an equivalent narrow lock". The local
adapter uses Node built-ins and operating system probes, without a new dependency or native
add-on. Real concurrent-process tests cover reclamation on each supported platform. The
lock stays behind its existing interface, so changing the mechanism does not require changing
build or activation callers. Its reclamation bounds are recorded in ADR 0002 above.

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
`LORE_E_SCHEMA_MISMATCH` and told to run `lorepack build`. Without the check the first symptom is
whatever statement happens to name a column that does not exist yet, from inside a query, with
nothing to connect it to the cause.

`state.sqlite` is the one database that *is* migrated, and the rule there runs the other way.
The migration runner refuses any database that records a migration this binary does not
ship, before applying anything, and the state store makes that check on a read-only
connection before opening for writing. State written by a newer Lorepack is therefore never
read or written by an older one (#570). Activation applies the same check to the target
build's catalog.

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

**A typo is not an attempted write.** A first word that is not a SQL statement keyword is
refused as a misspelling, with the keyword named where one is a single edit away, including an
adjacent-letter swap. `SELEC` used to be told "Only SELECT is allowed here" with a remediation
explaining that writes are forbidden, which is a rule that user did not break; for a model it was
worse, because the obvious repair was what it had already tried (#253).

**Errors say what rule was broken and nothing about the machine.** SQLite words a denial as
`access to t_secrets_f13bc4051aa0.c_0_sku is prohibited`, which names something the caller was
not allowed to see, so the message is replaced rather than wrapped. No path, no schema, no
other project.

`describeTable` is the required first step, not merely the preferred one. Table and column
names are generated, so a query written against the source's names does not run, and the
`sqlName` fields a description returns are the only place those generated names appear.

## Reader ownership and cleanup

Local runtime acquisition holds `.lore/read-lock` while capturing the pointer, opening
its catalog and publishing a private ownership record under `.lore/readers/`. Cleanup
holds the same short guard around its final reference check and deletion. This closes
the registration/deletion race without holding the guard during retrieval or preventing
activation while A still has readers.

Each acquired handle protects its build and normalized objects until release. A cached
idle SQLite connection retains one ownership record until it closes or transfers ownership
to its next request. This matters on Windows, where an open file cannot be deleted.
`prune` reports open runtime references alongside its usual retention window. An idle
runtime may therefore postpone deletion until it reads another build or closes.

Records use an unpredictable token plus PID, native process-start identity and host.
Cleanup may reclaim a proven dead or reused PID, but preserves foreign hosts and unknown
start identities. A malformed published record refuses cleanup rather than guessing.
Atomic-write leftovers never represent successful acquisition. These records are operational
ownership, excluded from build identity and packages; they are not credentials or sources.

Remote projections use their separate D1 ownership and cleanup protocol described in
[deployment](deployment.md). Explicit `serve --build` and `mcp --build` acquire
the same owned handle at startup and hold it between requests until shutdown. HTTP closes
its listener and drains HTTP/MCP before releasing selection; stdio releases after transport
close or process shutdown. A missing selection fails under the same acquisition guard.

If reader-record publication fails, acquisition closes any newly opened unowned catalog
before returning the failure. An existing owned connection keeps its valid reference.

## Verification without compilation

`validate --build <full-id>` holds a retained read owner and verifies copied
catalog/manifest/identity inputs in OS scratch. The archive verifier writes a
reference FTS catalog beside its input, so it must never run directly inside a
sealed build directory. Object checksums are streamed. Verification does not
rewrite retained reports or activate a build. A signal that is already aborted returns
`LORE_E_CANCELLED` before the catalog verifier creates a child process; its scratch inputs
remain unchanged. This avoids starting work that is already cancelled. See the
[validation contract](../validation.md) for coverage and limits.
