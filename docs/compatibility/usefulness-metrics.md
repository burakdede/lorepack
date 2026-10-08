# Usefulness metrics

Latency explains how quickly a system answers. It does not explain whether a result can be
audited, whether a bounded context stayed within its contract, or whether an update and rollback
were operationally safe. This document defines the v1 usefulness measurements and their limits.

The executable metric definitions are in
[`scripts/benchmark-metrics.mjs`](../../scripts/benchmark-metrics.mjs). Reproduce the checked-in
fixture with:

```sh
pnpm bench:usefulness -- --out benchmarks/usefulness/local.json
```

The run uses one small mixed-format corpus, the labelled retrieval workload, one source edit, a
second build and a pointer rollback. Its raw result is
[`benchmarks/usefulness/metrics-2026-10-08.json`](../../benchmarks/usefulness/metrics-2026-10-08.json).

## Metric definitions

| Metric | Formula | What it proves | What it does not prove |
|---|---|---|---|
| Provenance coverage | valid `SourceLocator` outputs / all outputs | Every counted result can be traced to a source coordinate | The source is correct or authoritative |
| Expected-location coverage | cited expected locations / labelled expected locations | The fixture's declared locations were returned or cited | Semantic relevance or factual accuracy |
| Search hit@k | cases with an expected location in the first k / search cases | Ranking behavior on the checked-in labels | General search quality |
| Context budget fit | bundles within budget / context cases | The output respected its declared token budget | That the selected context answers the task |
| Omission accounting | omitted items grouped by declared reason | Excluded candidates remain inspectable | That omission was the best human choice |
| Change review workload | added, changed and removed artifacts over all changed artifacts | The update surface is countable before review | Review time or human comprehension |
| Rollback recovery | active pointer equals target and rebuilt builds = 0 | Rollback restored an existing immutable build without recompilation | Recovery from every infrastructure failure |

Every ratio includes numerator and denominator. A denominator of zero produces `ratio: null`, not
an invented percentage. Subjective measures such as time-to-answer or time-to-review are not mixed
with these behavioral invariants.

## Current fixture evidence

The 2026-10-08 local run used 9 artifacts, 213 chunks and 2 tables on Darwin arm64:

- Search, context and table-row provenance were 43/43, 192/192 and 4/4.
- Labelled search hit@1 and hit@5 were both 15/15.
- Labelled context expected-location coverage was 15/15.
- All 15 context bundles fit their budgets. 1,542 omitted candidates were reported, all with the
  `diversity` reason in this fixture.
- One source artifact changed. The second build reused 6 artifacts and rebuilt 3.
- Rollback pointer change took 0.56 ms in this run, restored the original build, and rebuilt 0
  builds.

These are fixture results, not universal guarantees or release gates. Run the command again on a
different machine and keep the raw JSON with its commit and environment metadata.
