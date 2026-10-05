# Retrieval quality baseline

The committed baseline measures lexical ranking quality on the mixed-format corpus in
[`benchmarks/corpus/manifest.json`](../../benchmarks/corpus/manifest.json). It is a regression
signal, not a claim of correctness, factuality, semantic relevance or industry performance.

The workload has 30 labelled questions. Each label names an artifact and a source coordinate:
line range for text, heading and normalized line for DOCX, or page for PDF. The evaluator checks
search hit@1 and hit@5, then checks that every expected location for `contextForTask` appears in
its citations.

The 2026-10-05 result is:

| Measure | Cases | Result |
|---|---:|---:|
| Search hit@1 | 15 | 100% |
| Search hit@5 | 15 | 100% |
| `contextForTask` expected locations cited | 15 | 100% |

This is a repository-owned corpus with generated PDF and XLSX fixtures. It is useful for
catching ranking regressions against known material. It is not a correctness score. A public
industry corpus is a separate follow-up.

Reproduce the result with:

```sh
pnpm bench:quality
```

The command fails when any measure drops below the committed baseline in
[`benchmarks/quality/baseline-2026-10-05.json`](../../benchmarks/quality/baseline-2026-10-05.json).
The full report is in [`results-2026-10-05.json`](../../benchmarks/quality/results-2026-10-05.json).
The labelled questions live in [`queries.json`](../../benchmarks/corpus/queries.json).
