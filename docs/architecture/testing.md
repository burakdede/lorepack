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

1. Put it beside the module, in that package's `test/` directory.
2. Use a helper rather than reinventing temp directories or snapshot comparison.
3. For anything with a cross-platform dimension, do not skip on Windows. If you must,
   write down why in the test.

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

## Benchmarks

`pnpm bench` measures a full build, an incremental rebuild and warm search, and writes
machine metadata alongside the numbers. CI runs the same script and uploads the JSON as an
artifact.

Benchmarks are **reported, never enforced**. The reference machine and the gates are
backlog issue #101 in Phase 7; a shared CI runner is not that machine, so failing a build on
its timings would produce noise rather than signal. Every recorded result carries
`provisional: true` and the machine that produced it.
