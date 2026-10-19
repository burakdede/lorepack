# Finalize native capture after synchronous exit cleanup

## Status

Accepted, 2026-10-13. Issue #700, COVERAGE/F15. Supplements ADR 0017.

## Context

A collector registered before an owned exit listener snapshots too early.
Real cleanup executes but file capture records zero hits; stream capture instead
rejects counters arriving after completion. Moving the listener to the end once
cannot cover listeners registered later. A manually emitted exit event also
does not establish process termination.

## Decision

Finalize both collectors after the original process emitter returns from the
real exit event. Preserve its receiver, arguments, listener order and return
value. Use Node's verified boolean `_exiting` state to distinguish shutdown from
a manually emitted event. Reject an unsupported state rather than omit completion.

This contributor instrumentation depends on Node's exit implementation, verified
against installed Node 24.21.0. Runtime upgrades must requalify it with actual
ordinary/manual exit, compiled cleanup, restricted descriptor and host termination
fixtures. It introduces no published runtime dependency or additional permission.

## Consequences

Synchronous cleanup hits are retained before completion without modifying them.
Manual events keep their normal listener behavior without finalizing capture.
If a listener throws, the original emitter throws and capture remains incomplete;
do not manufacture successful completion. Asynchronous work scheduled during
shutdown is not awaited by the collector.

A JavaScript exit event still differs from observed OS close. Host reconciliation
retains both observations and requires permitted, successful kill evidence for an
interruption. These primitives do not qualify an incomplete capture campaign.
