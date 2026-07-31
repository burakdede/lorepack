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

## The Milestone 0 acceptance suite

`packages/cli/test/milestone-0.e2e.test.ts` is the automated proof of the exit criterion in
architecture section 21: editing one file creates a new immutable version, shows a correct
diff, and rolls back without re-indexing.

It drives the built binary as a subprocess, so it validates the contract a user meets,
including exit codes and printed output, rather than the internal functions that happen to
implement it today. Three choices in it are load-bearing:

- **The edit step writes a sibling file and renames over the original**, which is how real
  editors save. On Windows that is the case that breaks naive file handling, so simulating
  it is the difference between a suite that passes and a suite that is honest.
- **Rollback is proved by emptying every source file first.** Counting parse work can be
  satisfied by an accidental cache hit; an empty source tree cannot. If rollback re-indexed
  at all, the restored build would be empty, and the suite asserts it still answers.
- **Determinism runs the three conditions one machine can check** (twice in place, from a
  second absolute path, with enumeration shuffled) through `checkDeterminism`. The Windows
  against POSIX condition comes from the CI matrix, not from the test.

The suite also asserts that two workspaces on one machine produce byte-identical archives.
Across machines only the manifest and canonical roots must agree: `context.sqlite` page
layout is explicitly not part of build identity (section 11.3).

## Benchmarks

`pnpm bench` measures a full build, an incremental rebuild and warm search, and writes
machine metadata alongside the numbers. CI runs the same script and uploads the JSON as an
artifact.

Benchmarks are **reported, never enforced**. The reference machine and the gates are
backlog issue #101 in Phase 7; a shared CI runner is not that machine, so failing a build on
its timings would produce noise rather than signal. Every recorded result carries
`provisional: true` and the machine that produced it.
