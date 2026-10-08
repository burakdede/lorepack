# Benchmark evidence report

Protocol: `lorepack-benchmark-evidence v1`
Corpus: `b3755b10f9fc702f1f1f3182c3fc611d5d5e80df0d093a8e338862f43527b131`
Workload: `218c9a880b4ab88b2068f984af1a874953c7ae2343ba46b1c4ec4f84270db607`
Scale: `small`, profile: `mixed`

This report describes what was measured on the identified corpus and runner. It does not claim a universal winner.

| Implementation | Build or index p95 (ms) | Warm query p95 (ms) | Context p95 (ms) | Labelled hit@1 |
|---|---:|---:|---:|---:|
| Lorepack runtime | 716.64 | 3.84 | 11.59 | 1 |
| Direct SQLite FTS5 | 4.47 | 0.07 | not measured | 0.8 |
| Offline lexical RAG | not applicable | 0.18 | 0.4 | 1 |

## What Lorepack provides

- Provenance coverage: 1 for search, 1 for context, and 1 for table rows in the usefulness fixture.
- Rollback evidence: 0.44 ms pointer change, restored: true, rebuilt builds: 0.
- The direct FTS5 baseline is faster for warm lexical lookup here, and it does not implement Lorepack's bounded context, build identity or rollback contract.

## Claims and limitations

- The checked-in corpus is repository-owned and synthetic in part. It is not an industry benchmark.
- The workload is small and labelled for regression evidence, not a universal relevance test.
- The direct FTS5 and offline RAG baselines share Lorepack-normalized chunks, so their index measurements exclude parsing and chunking.
- The offline RAG report estimates tokens and does not call a model. Hosted model quality and cost are provider-dependent.
- These reports do not establish semantic superiority, factual correctness or lower total system cost.

Every number in this report is linked to a JSON pointer in `claims`. Use the raw artifacts and reproduction commands in the machine-readable report for independent review.
