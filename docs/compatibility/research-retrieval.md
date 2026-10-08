# Research track: deterministic and semantic retrieval

This note turns the research backlog in issue #519 into experiments with adoption gates. It is an
engineering plan and a record of decisions, not a claim that Lorepack currently implements every
method listed here. The default install remains model-free, native-free and deterministic.

## Decision frame

Lorepack is primarily a versioned context build system. Retrieval is a projection of an immutable
build. Every experiment must preserve build identity, `SourceLocator` provenance, explainable
ranking, read-only model-facing tools and rollback without recompilation.

The comparison baselines are deliberately different:

- Direct SQLite FTS5 is the raw lexical speed baseline. It starts after parsing and chunking and
  does not provide Lorepack's lifecycle contract.
- Traditional RAG is the semantic retrieval and answer-quality baseline. Its retrieval, context,
  token and model phases must be measured separately.
- Lorepack is evaluated on retrieval quality and operational usefulness. A faster or more accurate
  query alone is not sufficient if it weakens determinism, provenance or rollback.

## Existing baseline

The current ranker already applies deterministic field-aware BM25 weighting to path, title,
heading and body, followed by exact-match, status, authority, supersession and diversity rules.
Weights are versioned in [`packages/core/src/ranking/weights.ts`](../../packages/core/src/ranking/weights.ts)
and exercised by the runtime ranking tests. The research work is therefore to measure whether the
design improves the right query classes and whether a safe top-k index can reduce the cost of
candidate evaluation.

The shared corpus and workload are versioned in
[`benchmarks/corpus/manifest.json`](../../benchmarks/corpus/manifest.json) and
[`benchmarks/corpus/queries.json`](../../benchmarks/corpus/queries.json). The current evidence
report is [`benchmark-evidence.md`](benchmark-evidence.md).

The first safe-pruning prototype is recorded in
[`benchmarks/research/safe-pruning-2026-10-08.json`](../../benchmarks/research/safe-pruning-2026-10-08.json).
On the small profile it returned exact top-k IDs and scores for 15/15 queries and skipped 20.3%
of postings, but its p95 was 5.54 ms versus 0.14 ms for exhaustive scoring. This is a valid
correctness result and a negative speed result. It remains a research-only prototype and is not
evidence that Lorepack currently beats SQLite FTS5.

## Research map and experiments

### BM25, BM25F and field-aware ranking

Robertson and Sparck Jones establish the probabilistic relevance-weighting basis for BM25-style
ranking: [Microsoft Research, *Relevance weighting of search terms*](https://www.microsoft.com/en-us/research/publication/relevance-weighting-of-search-terms/).

Experiment:

1. Compare plain FTS5 BM25, the current field-aware ranker, and a BM25F-style field normalization
   variant on the same normalized chunks.
2. Report hit@1, hit@5, MRR, expected-location coverage, exact-query accuracy and paraphrase
   accuracy by query class.
3. Report warm-query p50, p95 and p99, index bytes, peak RSS and candidate count.
4. Keep the score decomposition and ranking version in every report.

Adoption gate: no exact lookup regression, at least a 5 percentage-point improvement in the
paraphrase or structural class, and no more than 20% warm-query p95 regression on medium and large
profiles. If the gate is not met, retain the current ranker and record the negative result.

### WAND and Block-Max WAND

Broder et al. describe safe dynamic pruning with WAND and report fewer full evaluations with little
effectiveness loss: [IBM Research, *Efficient query evaluation using a two-level retrieval process*](https://research.ibm.com/publications/efficient-query-evaluation-using-a-two-level-retrieval-process).
Ding and Suel extend safe top-k pruning with block-level maximum scores: [*Faster Top-k Document Retrieval Using Block-Max Indexes*](https://research.engineering.nyu.edu/~suel/papers/bmw.pdf).

Experiment:

1. Build an immutable sidecar postings index from the sealed normalized chunks. Do not replace
   SQLite storage or make the sidecar a second source of truth.
2. Implement exhaustive scoring and safe WAND-style pruning against the same deterministic score
   function.
3. Assert exact equality of top-k IDs, order, scores and provenance for every query. Approximate
   similarity is not sufficient for the safe-pruning claim.
4. Measure postings bytes, build time, warm p95, evaluated candidates and skipped postings at
   small, medium and large scales.

Adoption gate: 100% exact top-k equivalence, at least 1.25x warm-query speedup at medium or large
   scale, and no more than 25% sidecar-size overhead. Otherwise defer the sidecar and keep the
   SQLite path.

### SPLADE and learned sparse retrieval

SPLADE uses sparse lexical expansion with explicit sparsity regularization and exposes an
 effectiveness versus efficiency trade-off: [SPLADE](https://arxiv.org/abs/2107.05720) and
[SPLADE v2](https://arxiv.org/abs/2109.10086).

Experiment:

- Run only in an opt-in research profile with a pinned model, tokenizer, model hash, hardware and
  index format in build identity.
- Compare recall@1/5, MRR, nDCG, index bytes, build time, warm p95, peak RSS, token usage and
  reproducibility against BM25 and direct FTS5.
- Record model download and update cost separately. Do not add the model to the default install.

Adoption gate: a measured semantic-quality improvement on an external or carefully licensed
workload that justifies the model and index operational cost. Synthetic-corpus gains alone cannot
meet the gate.

### ColBERT and late interaction

ColBERT evaluates contextualized token representations with late interaction:
[ColBERT](https://arxiv.org/abs/2004.12832).

Experiment:

- Treat it as an optional reranking or high-quality tier after lexical candidate retrieval.
- Measure semantic recall, reranking latency, token and model costs, index size, update rebuild
  scope and provenance preservation.
- Compare against BM25, the optional SPLADE profile and the offline and hosted RAG baselines.

Adoption gate: the quality gain must remain after accounting for rerank latency, model versioning,
index rebuilds and provenance. The default Lorepack path remains model-free.

### Corpus and retrieval evaluation

BEIR provides heterogeneous zero-shot retrieval tasks:
[BEIR](https://arxiv.org/abs/2104.08663). BRIGHT targets reasoning-intensive retrieval:
[BRIGHT](https://arxiv.org/abs/2407.12883).

The local corpus remains the regression and lifecycle fixture. A separate licensed evaluation
pack should add exact lookup, semantic paraphrase, structural lookup, multi-hop and reasoning
queries. Each external dataset must record license, version, download checksum, preprocessing,
query count and whether the task permits source citation. No public claim should combine local
synthetic results with external results without keeping the rows separate.

### Context packing and evidence placement

*Lost in the Middle* studies how answer quality can vary with evidence position in long context:
[paper](https://arxiv.org/abs/2307.03172).

Experiment:

- Keep the same retrieved evidence and token budget, then compare original order, strongest-first,
  strongest-last, interleaved evidence and deduplicated grouped evidence.
- Measure context relevance, citation completeness, supported-answer rate, answer faithfulness,
  answer relevance, token count and model latency.
- Keep a no-model offline report for packing cost and a separately labelled hosted report for model
  outcomes.

Adoption gate: a placement policy must improve the pre-registered quality metric without increasing
the context budget or losing source locators. Until a model-backed run exists, report packing
behavior only and do not claim answer improvement.

### Provenance and end-to-end evaluation

KILT evaluates knowledge-intensive tasks together with provenance:
[KILT](https://aclanthology.org/2021.naacl-main.200/). ARES separates context relevance, answer
faithfulness and answer relevance:
[ARES](https://aclanthology.org/2024.naacl-long.20/).

The benchmark protocol will use these dimensions where a model-backed experiment is explicitly
authorized:

| Dimension | Metric | Default status |
|---|---|---|
| Retrieval | hit@1, hit@5, MRR, nDCG by query class | measured offline |
| Context | expected-location coverage, citation completeness, budget fit, omission reasons | measured offline |
| Provenance | valid locator coverage and citation precision | measured offline |
| Answer | supported-answer rate, faithfulness, relevance | not measured offline |
| Operations | build, incremental rebuild, rollback pointer change, rebuild avoidance | measured offline |
| Resources | index bytes, peak RSS, p50/p95/p99 latency, estimated or measured tokens | status labelled |

## Experiment matrix

| Profile | Corpus | Purpose | Required implementations |
|---|---|---|---|
| small | one mixed pack, 9 artifacts, 213 chunks | fast regression and pull requests | Lorepack, FTS5, offline RAG |
| medium | ten deterministic packs | scaling trend | Lorepack, FTS5, offline RAG, pruning prototype |
| large | forty deterministic packs | candidate and index stress | Lorepack, FTS5, offline RAG, pruning prototype |
| external | separately licensed evaluation pack | semantic generalization | opt-in model profiles only |

All rows record commit, corpus hash, workload hash, platform, architecture, runner, Node version,
ranking version, model and index versions where applicable. The raw artifact and claim ledger are
the only authority for a displayed number.

## Decision log

| Track | Current decision | Evidence needed to change it |
|---|---|---|
| Field-aware deterministic ranker | Keep and benchmark; already part of the default runtime | Quality and latency rows by query class |
| WAND or Block-Max sidecar | Prototype only; not a source-of-truth replacement | Exact top-k equivalence and measured speedup |
| SPLADE | Defer from default; optional research profile | External semantic gain versus operational cost |
| ColBERT | Defer from default; optional reranker | Quality gain, update cost and provenance preservation |
| Context placement | Measure offline packing first; no answer claim yet | Model-backed faithfulness and citation results |
| BEIR and BRIGHT | Use lessons and licensed subsets, not unqualified marketing rows | Reproducible dataset handling and comparable workload |

Failed experiments remain in `benchmarks/research/` with their raw report and reason for rejection.
No method is adopted by deleting a disappointing measurement.
