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
