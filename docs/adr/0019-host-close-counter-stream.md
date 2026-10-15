# Qualify shutdown counters against observed host close

## Status

Accepted, 2026-10-13. Issue #700, COVERAGE/F15. Supplements ADR 0018.

## Context

Natural process exit can run promise microtasks after synchronous exit listeners
return. A real compiled witness executes cleanup after the collector's JavaScript
completion frame. Those genuine counter writes remain in the inherited file, but
standalone replay cannot establish that the process has stopped writing.

## Decision

Allow late source and counter frames only when replay receives an observed host
close with the matching actual process and thread identity. Normal close must also
match the JavaScript exit code. Registered launch reconciliation supplies this
evidence after validating its launch and close receipts; interrupted execution
still requires the existing permitted termination evidence.

Preserve contiguous sequences, source hashes, exact increments and unique completion.
Replay without host closure keeps its strict rejection of frames after completion.
Do not await or schedule new owned work during shutdown.

## Consequences

Actual shutdown microtask hits are retained without inventing execution or another
JavaScript snapshot. Host OS close bounds the collected stream; the JavaScript
completion frame remains a separate observation. Real child regressions verify
late hits and reject wrong identity, wrong exit code and repeated completion.

File-snapshot capture still rejects late writes. Complete campaign integration
must choose qualified collection for each actual execution path and retain source
ownership and the original coverage targets.
