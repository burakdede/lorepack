# Retrieval comparison, 2026-10-04

This is an opt-in comparison of Lorepack's local runtime with a direct SQLite FTS5 index over
the same normalized chunks. It is not a comparison with a complete external product. The direct
index starts after parsing and chunking, while Lorepack's build measurement includes parsing,
normalization, chunking, catalog creation, validation, sealing and activation.

## Workload

The corpus and queries are shared with issue `#332`:

- [`benchmarks/corpus/manifest.json`](../../benchmarks/corpus/manifest.json) defines the real-format
  inputs and their checksums.
- [`benchmarks/corpus/queries.json`](../../benchmarks/corpus/queries.json) defines three search
  queries, two context tasks and the bounded table query.
- The large tier uses 40 mixed-format packs: 360 artifacts, 13.93 MB, 8,520 chunks and 80 tables.

The direct baseline indexes the same `chunks` rows in a standalone FTS5 table. It returns up to
ten ranked rows. It does not implement context assembly, omission accounting, build identity,
source locators, authority or status ranking, typed tables, activation or rollback.

## Result

Measured on an Apple M1 Pro, Darwin arm64, Node 24.18.1, SQLite 3.53.1:

| Measurement | Lorepack | Direct SQLite FTS5 |
|---|---:|---:|
| Index or build p50 | 13,493.46 ms full build | 100.30 ms index only |
| Index or build p95 | 13,846.57 ms full build | 105.16 ms index only |
| Index size | 55,160,832 bytes | 11,628,544 bytes |
| Peak RSS | 729.09 MiB | 74.78 MiB |
| Cold search | 19.80 ms | 0.53 ms |
| Warm search p50 | 3.87 ms | 0.09 ms |
| Warm search p95 | 12.78 ms | 0.29 ms |
| Warm search p99 | 14.11 ms | 0.31 ms |
| Context bundle p95 | 70.47 ms | unsupported |

The raw JSON is [`benchmarks/comparison/results-2026-10-04.json`](../../benchmarks/comparison/results-2026-10-04.json).
Reproduce it with:

```sh
pnpm bench:comparison -- --out benchmarks/comparison/results-<date>.json
```

The direct index is faster because it does less. Its numbers must not be presented as an
equivalent Lorepack runtime or as evidence that build identity, provenance and bounded context
are unnecessary. A maintained external lexical tool can be added later if its version, license,
installation shape and semantics can be verified without entering the default install.
