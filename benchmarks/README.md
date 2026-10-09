# benchmarks

Versioned benchmark suites and their reference-machine metadata. Release gates live in architecture section 5.5.

The v0.1 release summary is `benchmarks/releases/v0.1.json`, with the human-readable report in
`docs/compatibility/performance-v0.1.md`.

## Reference machines

The primary v0.1 numeric gates use the Linux development reference machine captured in the
committed benchmark artifacts: AMD Ryzen 9 3900X 12-Core Processor, 24 cores, 31 GB RAM, Linux
x64, Node.js 24.18.1, local SSD class storage. The historical JSON did not capture the exact
storage device, so future release-candidate runs must record the device model or hosted instance
type.

The true byte-envelope stress run uses a supplemental Darwin arm64 machine: Apple M1 Pro, 10
cores, 32 GB RAM, local APFS SSD, Node.js 24.18.1.

Envelope build measurements live under `benchmarks/envelope/`.

- `reference-2026-08-05.json` measures the 2,500-file shape with 39,010 chunks. It is the run
  that exposed #245: incremental rebuilds are slower than the original sub-2 s envelope gate.
- `byte-envelope-2026-08-14.json` measures 2,500 files and 1.005 GiB of source text. It exceeds
  the byte envelope, but also produces 387,110 chunks, so use it for byte stress and not as a
  retrieval-envelope substitute.
- `profile-2026-10-04.json` records the phase timings for a 2,500-file run. Generate the same
  shape with `node scripts/bench-envelope.mjs --files 2500 --profile --out <path>`.

The #245 decision is documented in `docs/architecture/build-orchestration.md`: v0.1 keeps
immutable build sealing, narrows the sub-2 s incremental rebuild claim to the lifecycle
benchmark corpus, and reports envelope rebuild latency instead of advertising an unmet number.

## Mixed-format corpus

`benchmarks/corpus/manifest.json` is the versioned input manifest for a real-format corpus, and
`benchmarks/corpus/queries.json` fixes the search, context and table workload shared by the
corpus and comparison harnesses. It
covers Markdown, plain text, HTML, PDF, DOCX, CSV, XLSX and source code, with a SHA-256 checksum
and provenance for every base artifact. The PDF and XLSX members are deterministic generated
fixtures written by `scripts/generate-corpus-fixtures.mjs`; they are ordinary files at benchmark
time, not parser test objects.

Run the three-tier measurement with:

```sh
pnpm bench:corpus -- --out benchmarks/corpus/results-<date>.json
```

Choose one scale when iterating locally. The default runs all three tiers:

```sh
pnpm bench:corpus -- --scale small
pnpm bench:corpus -- --scale medium --edge-case incremental
pnpm bench:corpus -- --scale large --edge-case unsupported
```

The supported edge-case profiles are `standard`, `incremental`, `unsupported`, and `tables`.
`incremental` exercises reuse after an edit, `unsupported` adds files with no parser so the
exclusion path is measured, and `tables` keeps the typed-table query workload visible. Every
report records `requestedScale` and `edgeCase`, so a downloaded result can be interpreted without
guessing which command produced it. These profiles test operational behavior and scale trends;
they do not establish universal retrieval quality.

The committed Apple M1 Pro result is
[`benchmarks/corpus/results-2026-10-04.json`](corpus/results-2026-10-04.json). It records file
count, bytes, nodes, chunks, table rows, peak RSS, build and incremental p50/p95, warm search,
context assembly and table-query latency. The medium and large tiers repeat the mixed pack with
path-local text, so they are scale trend evidence rather than an industry corpus. Issue `#386`
owns a same-workload retrieval comparison against an external baseline.

The first comparison is deliberately a direct SQLite FTS5 index over the same normalized chunks:
[`benchmarks/comparison/results-2026-10-08.json`](comparison/results-2026-10-08.json). It measures
index-only cost separately from Lorepack's full build, validates both implementation reports
against benchmark protocol v1, and labels the missing context and activation semantics. The
interpretation is in
[`docs/compatibility/retrieval-comparison-2026-10-08.md`](../docs/compatibility/retrieval-comparison-2026-10-08.md).

Retrieval quality is measured separately from latency. The 30-question labelled baseline and
its limits are documented in
[`docs/compatibility/retrieval-quality-2026-10-05.md`](../docs/compatibility/retrieval-quality-2026-10-05.md).

The opt-in RAG baseline measures retrieval, context assembly, prompt construction, token
accounting and optional hosted model calls as separate stages. Offline mode is credential-free and
does not claim answer quality. Reproduction instructions, provider configuration and the current
report are in
[`docs/compatibility/rag-benchmark.md`](../docs/compatibility/rag-benchmark.md) and
[`benchmarks/rag/offline-2026-10-08.json`](rag/offline-2026-10-08.json).

Usefulness metrics for provenance, expected-location coverage, context budgets, omission reasons,
change review and rollback are defined in
[`docs/compatibility/usefulness-metrics.md`](../docs/compatibility/usefulness-metrics.md), with a
reproducible fixture at [`benchmarks/usefulness/metrics-2026-10-08.json`](usefulness/metrics-2026-10-08.json).

The independent evidence report combines the same-workload rows, usefulness metrics, claim ledger
and clean-checkout review checklist:
[`docs/compatibility/benchmark-evidence.md`](../docs/compatibility/benchmark-evidence.md).

Research prototypes are kept separate from product claims. The current safe-pruning experiment and
its exactness and negative-speed result are documented in
[`docs/compatibility/research-retrieval.md`](../docs/compatibility/research-retrieval.md).
