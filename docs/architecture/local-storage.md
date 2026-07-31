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
