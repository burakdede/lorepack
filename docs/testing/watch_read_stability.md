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

A failed read remains a failed test. Diagnostics retain the original error as
`cause` and include the read phase, elapsed time, completed reads, churn rounds,
last build ID, child state and the final 16 KiB of supervisor output. There is
no retry or ignored connection reset.

Issue [#778](https://github.com/burakdede/lorepack/issues/778) follows a Windows
`read ECONNRESET` in
[this native run](https://github.com/burakdede/lorepack/actions/runs/38920581594/job/117039162373).
The unconsumed body is a confirmed client lifecycle defect. It does not establish
the cause of that connection reset. A recurrence requires investigation using
the captured context, without relaxing the stability gate.
