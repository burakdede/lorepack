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

The fixture also subscribes to the Node fetch
[Undici diagnostics channels](https://github.com/nodejs/undici/blob/v7.29.1/docs/docs/api/DiagnosticsChannel.md).
Before teardown it includes the last 64 request events and the number of older events
removed from the trace. Each event identifies the request, method, path without its
query, response status or error code, socket identity/use count, original local/remote
ports, byte counters and time since the previous completed response. Headers, bodies
and URL queries are never recorded. Subscription starts before the initial HTTP read
and stops after diagnostics on both success and failure. It adds no socket listeners,
does not read a stream and does not handle or suppress a transport error.

`packages/cli/test/http_diagnostics.test.ts` sends a real POST to a local server that
resets its TCP connection. It compares the unobserved and observed fetch error/cause,
verifies one reset request per attempt,
socket reuse and metadata, unchanged listener counts, redaction, bounded history,
origin isolation and unsubscription. This verifies the recorder, not the cause of the
native source-churn failure. Run it with:

```bash
pnpm exec vitest run packages/cli/test/http_diagnostics.test.ts
```

The recorder checks passed on Node 24.21.0 with bundled Undici 7.29.1, macOS arm64,
on 2026-10-17. Current-head native Windows qualification remains pending.

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

The current-main failure on
[7f7c3d2f's Windows job](https://github.com/burakdede/lorepack/actions/runs/39015872372/job/117347745672)
occurred at convergence headers after 5,244 churn rounds, 27 live reads and five
convergence reads. The supervisor still had null exit/signal values and its last
returned build ID was unchanged. This reproduces without the unmerged parser observer;
the reset cause remains unproved. The new request/socket trace is intended to distinguish
connection reuse, request timing and transport failure without changing the workload
or Node's default error/timeout handling.

## Rebuilding without blocking the runtime

`packages/cli/test/rebuild_responsiveness.e2e.test.ts` drives the actual bundled dev
binary with a test-only filesystem preload. After startup it arms one 10,500 ms pause
inside a candidate report's `fsyncSync`, preserving the actual write and fsync afterward.
A warmed keep-alive request fails with `read ECONNRESET` on the original shared event loop.
With watched rebuilds in the shipped worker, the same connection returns the previous
build while the write is paused. REST search, an established MCP client and Studio's HTML
also answer before the pause ends. The test then requires activation and MCP agreement.
It records the actual thread executing the stalled write. No HTTP retry is installed.

This is an additional controlled regression, not a shorter replacement for the original
300-document, sixty-second churn test. It does not change that test's preload, resources,
scheduling, timeouts, assertions or recorders. The specific filesystem operation behind
the historical Windows stall remains unidentified; native qualification is still required.

`packages/cli/test/background_build.test.ts` compares ordinary and worker builds for
identity, manifest and progress; verifies optional activation, error metadata/cause
messages, cancellation before startup and during parsing, retained active identity,
released project locks and discarded candidates. A failing progress/output sink cancels
the worker and propagates the original caller error after cleanup. Worker completion waits for exit.

Run the new cases, then the unchanged original suite:

```bash
pnpm build
pnpm exec vitest run --project cli packages/cli/test/background_build.test.ts packages/cli/test/rebuild_responsiveness.e2e.test.ts
pnpm exec vitest run --project cli packages/cli/test/dev.e2e.test.ts
```

On Node 24.21.0, macOS arm64, 2026-10-17, the actual-binary regression first failed with
`read ECONNRESET` and then passed with the worker. The initial five new cases passed locally.
The unchanged original dev suite also passed all 25 cases, including the sixty-second
churn and original cancellation workload. Native Windows qualification remains pending.
The packed-install gate additionally starts the installed dev command, edits a real source,
requires a new active build and checks cited search and Studio after the shipped worker runs.

The clean npm-installed tarball check passed locally with the same 145-package production
closure and no native module loaded. Its new watched edit activated and served cited
HTTP content and Studio through the installed worker. The existing source-free archive,
context, receipt and table-query checks also passed; npm audit reported zero production
vulnerabilities. These are development-machine results, not reference hardware claims.

Full local `pnpm verify` passed with unchanged tracked source fingerprint
`16bc8737e4f3eca3f99c80c1bcfb22663ec27b196e59a708cec0e0a5d5bb1665`:
3,766 default tests passed with four existing skips, all 183 architecture tests passed,
and 86 consolidated security tests passed with five existing platform skips. All remaining
policy, schema, documentation and executable-demo checks passed. A subsequent change adds
only the progress-sink regression and this verification record; production source is unchanged.
The final six focused cases then passed, including progress-sink cleanup, with strict
changed-test types, lint, formatting, documentation, punctuation and changeset checks green.
