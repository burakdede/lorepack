# v0.1 Performance Report

Date: 2026-08-14.

This report is the v0.1 release-gate evidence for issue `#101`. It links every published
performance claim to a committed benchmark artifact or a behavioural test. Claims that are not
earned are marked reported-only and must not be advertised as release gates.

## Reference Machines

The primary numeric gates use the Linux development reference machine captured in the committed
benchmark artifacts:

| Field | Value |
|---|---|
| Platform | Linux x64 |
| CPU | AMD Ryzen 9 3900X 12-Core Processor |
| Cores | 24 |
| Memory | 31 GB |
| Storage | local SSD class storage, exact model not captured in historical artifact |
| Node.js | 24.18.1 |

The true byte-envelope stress run uses a supplemental Darwin machine because the historical Linux
run covered the file-count envelope but not the byte envelope:

| Field | Value |
|---|---|
| Platform | Darwin arm64 |
| CPU | Apple M1 Pro |
| Cores | 10 |
| Memory | 32 GB |
| Storage | local APFS SSD |
| Node.js | 24.18.1 |

Future release-candidate runs should capture the exact storage device or hosted instance type in
the benchmark JSON. The v0.1 historical Linux artifacts did not record the storage model.

## Numeric Gates

| Gate id | v0.1 status | Scope | Target | p50 | p95 | Evidence |
|---|---|---|---:|---:|---:|---|
| fingerprint-file-envelope | pass | 2,500 files, 0.096 GiB, 39,010 chunks | < 4,000 ms | 857.76 ms | 915.68 ms | [`benchmarks/envelope/reference-2026-08-05.json`](../../benchmarks/envelope/reference-2026-08-05.json) |
| fingerprint-byte-envelope | reported-only | 2,500 files, 1.005 GiB, 387,110 chunks | none | 6,039.72 ms | 6,039.72 ms | [`benchmarks/envelope/byte-envelope-2026-08-14.json`](../../benchmarks/envelope/byte-envelope-2026-08-14.json), follow-up `#302` |
| warm-lexical-search | pass | 50,000 chunks, 2,000 documents, 30 iterations, 5 queries | < 250 ms | 18.77 ms | 21.45 ms | [`benchmarks/retrieval/phase-2-envelope-dev-machine.json`](../../benchmarks/retrieval/phase-2-envelope-dev-machine.json) |
| context-for-task | pass | `lore_context_for_task`, lexical bundle without semantic retrieval | < 1,500 ms | 58.92 ms | 199.96 ms | [`benchmarks/retrieval/phase-2-envelope-dev-machine.json`](../../benchmarks/retrieval/phase-2-envelope-dev-machine.json) |
| lifecycle-incremental-rebuild | pass | 60 documents, one changed ten-page document, 59 reused artifacts | < 2,000 ms | 139 ms | 139 ms | [`benchmarks/phase-1-dev-machine.json`](../../benchmarks/phase-1-dev-machine.json) |
| envelope-incremental-rebuild | reported-only | 2,500 files, 39,010 chunks, one changed document | none | 4,561.24 ms | 5,631.62 ms | [`benchmarks/envelope/reference-2026-08-05.json`](../../benchmarks/envelope/reference-2026-08-05.json), issue `#245` |

The byte-envelope run also measured incremental rebuild at 68,307.17 ms p95. It is intentionally
not a retrieval-envelope substitute because that corpus produced 387,110 chunks. Use
[`benchmarks/releases/v0.1.json`](../../benchmarks/releases/v0.1.json) for the machine-readable
summary.

## Behavioural Gates

| Gate id | Status | Evidence |
|---|---|---|
| progress-on-long-operations | pass | [`packages/core/test/progress.test.ts`](../../packages/core/test/progress.test.ts) verifies at least one measurable update per second during a simulated slow stage. |
| cancellation-preserves-active-build | pass | [`packages/cli/test/build.test.ts`](../../packages/cli/test/build.test.ts) verifies an aborted build leaves `builds/` and the active pointer untouched. |
| ctrl-c-acceptance | pass | [`tools/acceptance/src/scenarios/cancellation.ts`](../../tools/acceptance/src/scenarios/cancellation.ts) verifies interrupted CLI builds do not activate a candidate build. |

## Claim Policy

The full 1 GiB fingerprint gate is not advertised for v0.1 because the committed byte-envelope
run missed the old 4,000 ms p95 target. Issue `#302` owns either bringing that measurement under
the gate or keeping the claim removed. `pnpm check:performance-report` enforces that the report,
release baseline and section 5.5 stay aligned with the committed measurements.
