# Retrieval comparison, 2026-10-08

This is a controlled comparison of Lorepack's local runtime with a direct SQLite FTS5 index over
the same normalized chunks. Both reports use the same corpus manifest and labelled workload, and
both conform to [benchmark protocol v1](benchmark-protocol.md).

This is not a claim that Lorepack is faster than raw FTS5. The direct index begins after parsing,
normalization and chunking. Lorepack includes the sealed build and runtime contract. The comparison
exists to show both the cost and the additional behavior.

## Workload

- Machine: Apple M1 Pro, Darwin arm64, Node.js 24.18.1, SQLite 3.53.1.
- Corpus: 360 artifacts, 13.95 MB, 8,520 chunks and 80 tables.
- Workload: 15 labelled search cases, 15 labelled context cases, three repeated search queries and
  two repeated context tasks.
- Samples: three build or index runs, one cold query, 30 warm queries and 20 context assemblies.
- Source: [`benchmarks/comparison/results-2026-10-08.json`](../../benchmarks/comparison/results-2026-10-08.json).

The storage class was recorded as `unknown` for this local run, so these numbers are useful for
same-machine comparison and are not release gates.

## Results

| Measurement | Lorepack | Direct SQLite FTS5 |
|---|---:|---:|
| Build or index p95 | 14,121.80 ms full build | 103.55 ms index only |
| Warm search p95 | 13.43 ms | 0.22 ms |
| Cold search | 19.55 ms | 0.38 ms |
| Context assembly p95 | 72.25 ms | not implemented |
| Index or build bytes | 55,164,928 | 11,993,088 |
| Peak RSS | 697.95 MiB | 76.73 MiB |
| Search hit@1 | 100% | 80% |
| Search hit@5 | 100% | 80% |
| Expected source-location coverage | 100% | 100% |
| Context expected citations | 93.33% | not measured |

The numbers show the trade-off clearly. Raw FTS5 is much faster and smaller for ranked rows. On
this labelled workload, Lorepack's runtime ranker reached every expected search location in the top
five, while direct default BM25 reached 80%. Lorepack also assembled bounded, provenance-bearing
context. The direct baseline deliberately does not claim to implement that operation.

## What the baseline includes

The baseline uses a standalone FTS5 table with `unicode61`, `bm25(chunks_fts)`, and `path`,
`heading`, and `body` columns. Source coordinates are stored as unindexed columns so the baseline
can prove whether mapping was preserved. It still does not provide build identity, activation,
rollback, status-aware ranking, omission accounting, or bounded context assembly.

## What this does not prove

- It does not prove semantic superiority over embeddings or a RAG pipeline.
- It does not compare different parsers or ingestion systems.
- It does not represent every corpus or workload.
- The local storage class was not identified, so the result is not a release performance gate.
- The Lorepack token number is an internal deterministic estimate, not a provider tokenizer count.

Reproduce the comparison with:

```sh
pnpm bench:comparison -- --out benchmarks/comparison/local.json
```

The command builds both implementation reports from the same checked-in inputs, validates the
protocol reports before writing the summary, and preserves the raw measurements for inspection.
