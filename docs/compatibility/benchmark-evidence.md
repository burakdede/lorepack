# Benchmark evidence

Lorepack's primary goal is operationally safe, reproducible context, not winning a raw
substring lookup contest. A Lorepack build is immutable, carries source locations, can assemble
bounded context, and can be activated or rolled back without rebuilding. Direct SQLite FTS5 is a
useful lower-level speed baseline. RAG is a pipeline comparison that must keep retrieval,
context assembly, token accounting and model answer quality separate.

The current checked-in evidence report is [`report.md`](../../benchmarks/evidence/2026-10-08/report.md).
Its machine-readable companion is [`report.json`](../../benchmarks/evidence/2026-10-08/report.json).
The report's `claims` array is the claim ledger. Every displayed value has an owner, denominator,
corpus and workload identity, runner identity, raw artifact path and JSON pointer.

## Current measured comparison

The following rows are from the small mixed profile on an Apple M1 Pro, macOS arm64, Node.js
24.18.1. They are regression evidence for the checked-in corpus and workload, not universal
performance claims.

| Implementation | Build or index p95 | Warm query p95 | Context p95 | Labelled hit@1 |
|---|---:|---:|---:|---:|
| Lorepack runtime | 716.64 ms | 3.84 ms | 11.59 ms | 15/15 |
| Direct SQLite FTS5 | 4.47 ms | 0.07 ms | not measured | 12/15 |
| Offline lexical RAG | not applicable | 0.18 ms | 0.40 ms | 15/15 |

The raw implementation reports are [`comparison.json`](../../benchmarks/evidence/2026-10-08/comparison.json),
[`rag.json`](../../benchmarks/evidence/2026-10-08/rag.json), and
[`usefulness.json`](../../benchmarks/evidence/2026-10-08/usefulness.json). The comparison uses the
same normalized chunks and the same labelled workload. FTS5 and offline RAG therefore measure
index and retrieval cost after parsing and chunking. Their numbers are not end-to-end ingestion
costs.

The measured conclusion is narrow and useful: direct FTS5 is faster for warm lexical lookup on
this runner, while Lorepack supplies lifecycle semantics that the direct index does not implement.
The current evidence does not establish semantic superiority, factual correctness, model answer
quality, or lower total cost.

## What is measured

- Retrieval quality uses expected locations in 15 labelled cases. It is not a general semantic
  relevance benchmark.
- Provenance is counted as valid `SourceLocator` objects divided by all outputs on each surface.
  The usefulness fixture recorded 43/43 search hits, 192/192 context citations, and 4/4 table
  rows with valid provenance.
- Context assembly records bounded bundles and omitted candidates with reasons. It does not imply
  that an omitted item was unimportant.
- Rollback records pointer-change latency, restoration of the expected build, and rebuilds
  performed. The usefulness fixture restored the build in 0.44 ms and performed zero rebuilds.
- RAG token counts are explicitly estimates in offline mode. No model is called, so answer
  quality and provider cost are not measured.

## Reproduce from a clean checkout

The default commands require no account, API key, model download, Docker, or native add-on. They
write only to the directory supplied with `--out`.

```sh
pnpm install --frozen-lockfile
pnpm build

mkdir -p /tmp/lorepack-benchmark
export LORE_BENCH_PACKS=1
export LORE_BENCH_SCALE=small
export LORE_BENCH_PROFILE=mixed

node scripts/bench-retrieval-comparison.mjs \
  --out /tmp/lorepack-benchmark/comparison.json
node scripts/bench-rag.mjs \
  --out /tmp/lorepack-benchmark/rag.json
node scripts/bench-usefulness.mjs \
  --out /tmp/lorepack-benchmark/usefulness.json

node scripts/check-benchmark-artifacts.mjs /tmp/lorepack-benchmark \
  --summary /tmp/lorepack-benchmark/summary.md
node scripts/render-benchmark-evidence.mjs /tmp/lorepack-benchmark \
  --json /tmp/lorepack-benchmark/report.json \
  --markdown /tmp/lorepack-benchmark/report.md
```

Scale is explicit. Use `LORE_BENCH_PACKS=10 LORE_BENCH_SCALE=medium` or
`LORE_BENCH_PACKS=40 LORE_BENCH_SCALE=large` to repeat the same workload at larger sizes. Keep
the profile, commit, corpus hash, workload hash, platform and runner visible when comparing rows.

The direct RAG mode is the reproducible default. Hosted RAG is a separate manual workflow that
requires an explicitly configured provider environment. It must not be compared with offline
numbers without recording model, tokenizer, provider, pricing inputs and measured usage.

## CI and automatic updates

`.github/workflows/benchmarks.yml` runs on every pull request, every push to `main` after a merge,
on the daily schedule, and by manual dispatch. Pull requests use the small profile. Main pushes,
scheduled and manually selected runs use the medium or large profile. Ubuntu, Windows and macOS
produce separate raw artifacts, then the summary job validates the shared identities and uploads a
machine-readable JSON and Markdown summary.
Unlike rows from one runner, cross-platform rows are never averaged.

The workflow retains raw pull-request artifacts for 30 days and summary artifacts for 90 days.
The checked-in report is a reviewed snapshot. A CI artifact is the authoritative result for a
particular run, because it includes the commit SHA and runner-specific samples.

## Corpus provenance and limitations

The public corpus manifest is [`benchmarks/corpus/manifest.json`](../../benchmarks/corpus/manifest.json).
It records each artifact path, format, byte count, SHA-256 checksum and provenance policy. The
text fixtures are repository-owned Apache-2.0 project material. PDF and XLSX inputs are
deterministically generated by `scripts/generate-corpus-fixtures.mjs` from repository-owned
fixture specifications. The corpus intentionally exercises Markdown, text, HTML, PDF, DOCX, CSV,
XLSX and source code paths, but it is small and partly synthetic.

The workload is [`benchmarks/corpus/queries.json`](../../benchmarks/corpus/queries.json). It
contains exact, paraphrase, structural, bounded-context and table tasks. The workload hash in
every report prevents an unnoticed query-set change.

These results do not prove that Lorepack is faster than FTS5, that lexical retrieval is semantic,
or that a particular hosted RAG provider produces better answers. They show a more specific
advantage: Lorepack makes changing context a versioned operational artifact with provenance,
bounded assembly, deterministic identity, inspectable diffs and rollback evidence.

## Independent review checklist

- [ ] Confirm the report commit SHA, corpus manifest hash and workload hash match every
  implementation row.
- [ ] Open every raw artifact named by the report's `sourceReports` and follow each claim's JSON
  pointer.
- [ ] Re-run the clean-checkout commands without credentials and compare samples without averaging
  unlike runners.
- [ ] Confirm the manifest checksums and generated-fixture provenance before adding or replacing
  corpus members.
- [ ] Confirm offline RAG has `quality.answer.status` set to `not-measured` and does not print
  model responses or secrets.
- [ ] Treat every claim as expired for a changed corpus, workload, ranking implementation, Node
  version, or runner policy. Re-run and update the report.
- [ ] Check that no documentation sentence generalizes a measured row into a universal claim.
