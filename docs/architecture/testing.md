# Testing strategy

Architecture section 20 defines eight categories. This page says where each lives and how
to add one. The shared helpers are in `tools/test-support`.

| Category | Where | Helper |
|---|---|---|
| Golden parser fixtures | `fixtures/documents`, `fixtures/spreadsheets` | `compareGolden` |
| Determinism | alongside the module under test | `checkDeterminism` |
| Path and Windows | `packages/core/test/paths.test.ts`, `fixtures/paths` | `withTempProject` |
| Watcher | Phase 3 | `withTempProject` |
| Adapter contract | Phase 2, run against every implementation | contract suite |
| Retrieval | Phase 2, `fixtures/expected` | `compareGolden` |
| Client connector | Phase 3 and 5, recorded config fixtures | `withTempProject` |
| Security | alongside the surface under test | none |

## Golden files

Committed JSON with sorted keys, so a diff shows real changes rather than key churn.

```ts
const result = compareGolden(goldenPathFor('markdown/headings'), parsed);
expect(result.message ?? '', result.path).toBe('');
```

Regenerate deliberately with `UPDATE_FIXTURES=1 pnpm test`, then read the diff. A golden
that changes without a reviewed reason is a defect, not a formality.

## Determinism

`checkDeterminism` runs the conditions from section 20.3 that one machine can check:
twice in one place, from a second absolute path, and with enumeration order shuffled. The
Windows and POSIX condition comes from the CI matrix.

```ts
const report = await checkDeterminism({
  files: { 'a.md': '# A', 'b.md': '# B' },
  produce: (project) => buildId(project.root),
});
expect(report.message ?? '').toBe('');
```

It detects the three things that actually break reproducibility: dependence on the
absolute path, dependence on enumeration order, and a clock or counter leaking into
output. Each of those has a test proving the helper catches it.

## Temporary projects

`withTempProject` materialises files into a randomised temp directory and cleans up even
when the callback throws. The randomised root is not incidental: it doubles as the
"different absolute workspace path" determinism condition.

Cleanup is best effort on Windows, where a lingering handle can block removal. A leaked
temp directory must never fail a test.

## Fixture layout

```text
fixtures/
  documents/     parser inputs by format
  spreadsheets/  table inputs
  paths/         discovery and path-safety trees
  expected/      committed golden outputs
```

Per architecture section 20.2, each format fixture eventually carries: the source, expected
artifact metadata, expected node tree, expected table schema and sample, expected locators,
expected warnings, and a canonical hash.

## Adding a test

Local lifecycle regressions use compiled temporary projects and real SQLite files.
`runtime-local.test.ts` checks missing manifests and unknown-table refusal followed by
a valid query. `damaged-build.test.ts` deletes migration history, checks the typed
schema error, then proves the documented rebuild restores a cited read.
`activate.test.ts` verifies complete missing-object details with a bounded human
summary and an unchanged active pointer. Unsupported rollback targets must fail
before any deployment adapter operation or local configuration change.

1. Put it beside the module, in that package's `test/` directory.
2. Use a helper rather than reinventing temp directories or snapshot comparison.
3. For anything with a cross-platform dimension, do not skip on Windows. If you must,
   write down why in the test, and add the line to the allow-list in
   `tools/security/test/test-skips.test.ts`. Biome rejects a literal `.skip` or `.only`
   (`noSkippedTests`, `noFocusedTests`); the allow-list covers the forms Biome cannot see
   (`skipIf`, `runIf`, `todo`, `context.skip()` and `it.skip` used as a value), so every way
   a test can stop running is a reviewed line rather than a side effect.

## The acceptance suite

`tools/acceptance` holds every scenario a person runs, as data, and executes it against the
built binary. It is the automated proof of the exit criterion in architecture section 21:
editing one file creates a new immutable version, shows a correct diff, and rolls back
without re-indexing. See [`docs/testing/acceptance.md`](../testing/acceptance.md) for the
generated catalogue, which is also the manual checklist.

```bash
pnpm acceptance                 # the whole suite
pnpm acceptance -t lifecycle    # one area
pnpm acceptance:docs            # regenerate the checklist after adding a scenario
```

It is deliberately outside `pnpm test`. It spawns the binary dozens of times and builds
corpora of thousands of documents, so it runs as its own CI job on the same three-OS matrix.

Four choices in it are load-bearing:

- **Scenarios are data, not test files.** A closed set of actions has one execution and one
  human sentence each, which is what lets the same list drive the suite and the checklist.
  A checklist maintained beside the suite drifts, and `acceptance:docs:check` fails when it
  does, for the same reason `schemas:check` exists.
- **The runner spawns and signals a real process.** Cancellation was broken for the whole of
  Phase 1 (#146) because the tests injected an `AbortSignal`, which proves the checkpoints
  honour an aborted signal and proves nothing about the signal arriving.
- **The edit step writes a sibling file and renames over the original**, which is how real
  editors save. On Windows that is the case that breaks naive file handling, so simulating
  it is the difference between a suite that passes and a suite that is honest.
- **Rollback is proved by emptying every source file first.** Counting parse work can be
  satisfied by an accidental cache hit; an empty source tree cannot. If rollback re-indexed
  at all, the restored build would be empty, and the scenario asserts it still answers.

Scenarios no machine here can run, such as progress on a real TTY, live in the catalogue
flagged `manual` and render into the checklist. A scenario left out is not manual, it is
invisible.

Determinism runs the conditions one machine can check: twice in place, and from a second
absolute path, comparing the build id, the whole manifest, and the packed archive byte for
byte. Windows against POSIX comes from the CI matrix. Across machines only the manifest and
canonical roots must agree, because `context.sqlite` page layout is explicitly not part of
build identity (section 11.3).

`checkDeterminism` in `tools/test-support` remains the helper for unit-level determinism,
where the value under test is a hash rather than a command.

Cloudflare acceptance shares one remote runtime, so its CI job uses a shared concurrency
group with `queue: max` and `cancel-in-progress: false`. Serialization protects the runtime
from overlapping deployments. Retaining waiting jobs matters separately: GitHub's default
queue keeps only one pending job and cancels it when another arrives, which can prevent a
PR from ever completing its Cloudflare gate during concurrent work.

## Benchmarks

The existing pruning research command also has an offline report-contract test.
It runs the small mixed fixture, compares stdout with the written JSON, verifies
input digests and query coverage, and reconciles posting counters and exact top-k
results. Separate cases cover unknown terms, repeated Unicode tokens and cutoff
ties. These checks establish report correctness, not a runtime speed claim; the
prototype remains outside the default runtime.

The offline RAG report test runs the existing command with its full iteration counts.
It checks corpus/workload hashes, query counts, estimated prompt tokens and explicit
unmeasured answer/cost fields. Missing build paths and unsupported modes fail in
real subprocesses before database access. These tests make no provider or model calls.

`pnpm bench` measures a full build, an incremental rebuild and warm search, and writes
machine metadata alongside the numbers. CI runs the same script and uploads the JSON as an
artifact.

Benchmarks are **reported, never enforced**. The reference machine and the gates are
backlog issue #101 in Phase 7; a shared CI runner is not that machine, so failing a build on
its timings would produce noise rather than signal. Every recorded result carries
`provisional: true` and the machine that produced it.

Shared Claude Code configuration is `.mcp.json` at the project root, so it has
no intermediate directory to replace with a link. The connector safety contract
checks that layout explicitly. File-link and permission evidence runs for every
connector; intermediate-directory link evidence runs for Codex and VS Code,
whose configuration is nested inside the project.


Native coverage of the original project-write profile retains nested launch, close and
counter records beneath a host-created private namespace in `.lorepack`. The parent
checks ownership and moves only its own regular receipt files before fixture cleanup.
No outside filesystem write grant is added. A hash-bound CommonJS collector preload
starts the inherited counter stream before original ESM preloads and restores the
caller-visible arguments before they execute. A preload failure therefore has actual
start and completion frames with no owned source hits. Empty or truncated streams
remain invalid. See [ADR0026](../adr/0026-project-capture-custody.md).

HTTP contract tests exercise optional host plan/source reads through actual routes,
including retained-build selection, typed host failures and absent capabilities.
MCP header tests verify UTF8 resource URI decoding without changing the delivered
JSON body, and reject invalid base64 before the transport handler runs.

Retention contracts use actual SQLite catalog/table fixtures and the existing R2
port fixture. A real abort trigger proves catalog rollback and resumption after
physical-table removal. Empty-result port variants preserve decisions for cold
targets, unactivated staged builds and previews whose build later became active.
Missing archives are never reported as successful deletions.

Archive contracts use complete ZIPs with actual catalog bytes. Tests distinguish
matching envelope checksums from supported build identity, report missing members
with their expected digests, and bound manifest/identity bytes before decoding.

Activation failure tests abort the final build-state update in actual SQLite,
after the pointer update and old-build demotion. They assert rollback of all three
facts, reopen the state database and retry without consuming a generation.

Query contracts check token and byte budgets independently, compound remote row
estimates and ordinary nested/window forms. Local and remote profiles keep their
existing admission rules and limits; defensive guards are not removed for coverage.
