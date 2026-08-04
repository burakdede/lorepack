# Build orchestration

`lore build` hides compile, index, validate and activate behind one operation
(architecture section 6.5) without hiding what happened (section 4.9). This is the stage
order and the reasons it cannot be rearranged.

## Stages

```
lock -> plan -> parse -> index -> validate -> seal -> record -> activate
```

1. **Lock.** `ProjectLock` (a `mkdir`-based cross-process lock) serializes builds for one
   project. A waiting build reports the pid it is waiting for through the progress bus
   rather than appearing to hang.
2. **Plan.** The orchestrator calls the same `createPlan` that `lore plan` prints, so the
   preview and the executed work cannot diverge.
3. **Parse.** Cached parses are reused by `cacheKey`, which covers content, parser
   identity, normalization version and the configuration that affects output. A supported,
   included file that fails to parse fails the whole candidate (section 6.9).
   A parser [may be asynchronous](#a-parser-may-return-a-promise).
4. **Index.** Everything goes into a candidate database under `.lore/tmp/`, in one
   transaction.
5. **Validate.** Eleven independent checks (see `validateCandidate`). Failure names the
   check and the record, not "build failed".
6. **Seal.** A single atomic rename moves the candidate into `.lore/builds/<build id>`.
7. **Record and activate.** Activation is a pointer change in one transaction. With
   `--no-activate` it is skipped, leaving a verified build for CI to inspect or pack.

## Why the order matters

Nothing enters `builds/` until every check has passed. That is the mechanism behind "a
failed build can never corrupt the active version": a failure or an interrupt at any stage
before the seal discards a directory that no reader ever knew about, and the previously
active build keeps serving.

The build id is derived before the candidate is written, from content alone, so the
directory is named correctly the first time and an identical rebuild is recognised as
already done rather than duplicated.

## A parser may return a promise

`ArtifactParser.parse` returns `ParsedArtifact | Promise<ParsedArtifact>`. Two of the formats
Phase 5 adds leave no choice: `pdfjs.getDocument()` resolves a promise and
`mammoth.convertToHtml()` is a thenable.

**Pure and asynchronous are not in tension.** What "pure" protects here is that a parser reads
nothing but its input, keeps no state between calls, and returns the same nodes for the same
bytes. None of that is weakened by the work taking a tick. A synchronous parser needs no
change, because `ParsedArtifact` is assignable to the union, so the Markdown and text parsers
still return a value directly.

The load-bearing detail is at the call site, and it is not the value:

```ts
result = await parser.parse({ ... });   // inside the try
```

Without the `await`, the `try` catches nothing when the parser is asynchronous. The promise is
returned, the block exits, and a later rejection surfaces as an unhandled rejection that ends
the process instead of failing one artifact with `LORE_E_PARSE_FAILED` and a path. The type
checker is equally happy either way, which is why
`packages/cli/test/async-parser.test.ts` drives a real rejecting async parser through
`runBuild` rather than asserting the signature: removing the `await` fails that test, and the
type checker still passes.

## The parse cache

`.lore/cache/parse/<xx>/<key>.json`, sharded by the first byte of the key. A hit is only
used when its normalized body is still present in the object store, because the cache and
the object store can be pruned independently and reusing a parse whose body is gone would
produce a build that cannot answer a source read.

A corrupt, truncated or unwritable cache is treated as a miss. A cache must never fail a
build that is otherwise complete.

## Storage choice: no WAL

Both the state database and every build database use SQLite's rollback journal, not WAL.
A WAL database grows `-wal` and `-shm` siblings, and a *read-only* connection creates them
without being able to clean them up. That would make `lore status` write to disk and a
sealed build three files rather than one. Writers are already serialized by the project
lock, so WAL's concurrency buys nothing here; `busy_timeout` covers a reader that arrives
mid-write.

## Measured performance

Provisional, on the development machine. The reference machine is backlog issue #101, and
the gates in architecture section 5.5 apply there, not here. Nothing below is advertised.

| Measurement | Result | Reference gate |
|---|---|---|
| Full build, 60 documents of 10 pages (600 chunks) | 836 ms | not gated |
| Incremental rebuild after editing one document | 139 ms | 2000 ms |
| Warm search, p50 | 2.55 ms | not gated |
| Warm search, p95 | 2.61 ms | 300 ms |

Reproduce with `pnpm bench`, or `node scripts/bench.mjs --out <file>` after `pnpm build`.
The script records the CPU, core count, memory and Node version alongside the numbers,
because a performance figure without its machine is not a measurement.

Recorded 2026-08-01 on AMD Ryzen 9 3900X, 24 cores, 31 GB, Node 24.18.1, Linux x64. The
committed run is `benchmarks/phase-1-dev-machine.json`.
