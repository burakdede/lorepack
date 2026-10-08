# Benchmark protocol v1

Lorepack comparisons use one protocol so a direct SQLite FTS5 result, a RAG result, and a
Lorepack result cannot quietly use different inputs or measurement rules.

The machine-readable contract is [`schemas/benchmark-report.json`](../../schemas/benchmark-report.json).
The checked-in sample can be validated from a clean checkout with:

```sh
pnpm check:benchmark-protocol
```

## What every report identifies

Every report describes one implementation on one machine. It records the protocol version,
implementation, commit, platform, architecture, runner, Node version, CPU, storage class, corpus
manifest and hash, workload and hash, sampling policy, token accounting, phase statistics, and a
claim ledger.

Comparisons aggregate reports only after these identities match. A comparison must not average
results from different corpus hashes, workload hashes, platforms, storage classes or protocol
versions without showing the dimensions separately.

## Shared workload

The corpus is the checked-in manifest under [`benchmarks/corpus/manifest.json`](../../benchmarks/corpus/manifest.json).
The labelled workload is [`benchmarks/corpus/queries.json`](../../benchmarks/corpus/queries.json).
The same files are supplied to Lorepack and every baseline. A baseline may use a different index
or model, but it must not translate the source corpus or silently change the query set.

The workload is split into exact lookup, semantic paraphrase, structural lookup, bounded context
tasks, and typed table tasks.

## Lifecycle phases

Implementations report only phases they actually execute, using the shared names:

`ingest`, `build`, `incremental-rebuild`, `index-build`, `index-warmup`, `cold-query`,
`warm-query`, `context-assembly`, `table-query`, and `model-generation`.

Build and index construction are reported separately from query latency. Warmup is not hidden in
steady-state samples. Failures count in the phase and are never silently discarded.

## Token policy

Token counts are separate from latency. A non-RAG implementation uses `status: not-applicable` and
sets tokenizer, model, and every count to `null`. An estimate names its tokenizer and remains an
estimate. A measured count names the tokenizer and model or provider used to obtain it.

The protocol does not treat a deterministic whitespace estimate as a model-token measurement.

## Claim policy

Numbers are not product claims by themselves. Each report carries evidence for every measured
claim. `reported-only` means a useful observation without a release gate. `quality-result` means a
retrieval or answer-quality measurement. `not-measured` is required when a tempting comparison was
not run, such as semantic quality for direct FTS5.

The protocol establishes comparability. It does not imply that the synthetic corpus represents an
industry corpus or that one implementation wins every workload.
