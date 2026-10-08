# RAG benchmark

The RAG baseline answers a different question from the direct FTS5 comparison. It measures a
retrieval-augmented pipeline as separate stages:

`retrieve -> assemble context -> construct prompt -> optional model request`

The offline profile has no provider dependency and does not call a model. It uses the shared
normalized chunks, SQLite FTS5 with BM25 ranking, a fixed top-k of 5, a 1,200-token context
budget, and a deterministic token estimate. It is therefore a lexical retrieval pipeline, not an
embedding or semantic RAG claim.

## Reproduce offline

From a clean checkout:

```sh
RAG_BENCH_MODE=offline pnpm bench:rag -- --out benchmarks/rag/local.json
node scripts/benchmark-report.mjs benchmarks/rag/local.json
```

The command builds the mixed corpus, creates an independent FTS5 index, runs the shared workload,
validates the report against protocol v1, and writes no credentials. The checked-in reference is
[`benchmarks/rag/offline-2026-10-08.json`](../../benchmarks/rag/offline-2026-10-08.json).

## Current evidence

The reference run used an Apple M1 Pro, Darwin arm64, Node.js 24.18.1, 360 artifacts, 8,520
chunks and 15 labelled search plus 15 labelled context cases. It is same-machine evidence, not a
release gate.

| Measurement | Result |
|---|---:|
| Index build p95 | 98.03 ms |
| Warm retrieval p95 | 1.15 ms |
| Context assembly p95 | 4.90 ms |
| Prompt construction p95 | 0.02 ms |
| Search hit@1 and hit@5 | 15/15 and 15/15 |
| Context cases containing every expected citation | 5/15 |
| Context items with provenance | 72/72 |
| Estimated input, retrieved-context and prompt tokens | 190, 5,900 and 6,400 |

The result demonstrates why retrieval hit rate is not answer quality. Offline mode has no answer
or task-success measurement. It reports those fields as not measured rather than treating retrieved
text as a correct answer.

## Optional hosted mode

Hosted execution is opt-in and uses an OpenAI-compatible JSON endpoint. It is never part of the
default local or pull-request benchmark. Supply credentials through the environment, not command
output or checked-in files:

```sh
RAG_BENCH_MODE=hosted \
RAG_BENCH_ENDPOINT=https://provider.example/v1/chat/completions \
RAG_BENCH_API_KEY="$RAG_BENCH_API_KEY" \
RAG_BENCH_MODEL=provider-model \
RAG_BENCH_TOKENIZER=provider-tokenizer \
pnpm bench:rag -- --out /tmp/rag-hosted.json
```

Optional pricing variables are `RAG_BENCH_INPUT_USD_PER_MILLION` and
`RAG_BENCH_OUTPUT_USD_PER_MILLION`. The report records model, provider, tokenizer, stage latency,
provider usage fields and estimated cost only when both prices are supplied. Errors redact the API
key and bearer values. The benchmark does not print model responses.

Hosted numbers are provider-, model-, tokenizer-, prompt- and date-dependent. They must remain
separate from offline and Lorepack rows, and a hosted result without those identities is invalid.

## What this proves

- The pipeline stages and their latency can be inspected independently.
- Retrieval, context citation coverage, token usage and model-answer measurements are separate.
- A contributor can reproduce the retrieval and prompt stages without an account or API key.

## What this does not prove

- It does not prove semantic superiority over embedding retrieval or any provider.
- It does not measure factuality or task success in offline mode.
- It does not make provider cost stable across models or dates.
- It does not replace Lorepack's immutable build, activation, rollback or provenance contract.
