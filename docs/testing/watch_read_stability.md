# Watch read stability

The `watching while it serves` suite in `packages/cli/test/dev.e2e.test.ts`
drives the actual dev binary while sources change for sixty seconds. It keeps
300 stable documents, changes twenty transient files each round, reads HTTP and
MCP every two seconds, and requires convergence afterward. Its deadlines,
workload and read assertions remain unchanged.

Every `/v1/build` fetch consumes the response body and validates it with
`buildDescriptionSchema` before the next MCP search. Node fetch uses Undici;
[its response-body guidance](https://github.com/nodejs/undici#garbage-collection)
requires consuming or cancelling bodies to release connection resources reliably.
The build ID from the body also supplies useful failure context.

A failed request remains a failed test with its original error and cause.
The parallel read retains its cause wrapper. Before supervisor teardown and
fixture removal, a failure-only diagnostic records the whole test phase, read
and cleanup phases, elapsed time, completed reads, churn rounds, last build ID,
child state and the final 16 KiB of supervisor output. This includes initial
HTTP/MCP setup, convergence and the final MCP read, beyond the parallel loop.
There is no retry or ignored connection reset.

A disposable local probe sends a real TCP reset during the initial build fetch.
Before the full-phase capture it reproduced an unlabelled `fetch failed` with
an `ECONNRESET` cause. Afterward it also identified `initial build headers`,
the live supervisor and its output, while preserving that original failure.
The injected failure is a diagnostic probe, not qualification of the unchanged
sixty-second workload. Run that workload separately without the injection.

Issue [#778](https://github.com/burakdede/lorepack/issues/778) follows a Windows
`read ECONNRESET` in
[this native run](https://github.com/burakdede/lorepack/actions/runs/38920581594/job/117039162373).
The unconsumed body is a confirmed client lifecycle defect. It does not establish
the cause of that connection reset. A recurrence requires investigation using
the captured context, without relaxing the stability gate.

The same case recurred on
[PR #763's Windows job](https://github.com/burakdede/lorepack/actions/runs/38949722919/job/117137763947).
Its failing phase remains unknown: the original parallel-read wrapper did not
appear in the report. A passing cancellation case in that job does not resolve
the separate cancellation investigation in #764.
