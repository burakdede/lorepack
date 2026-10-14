# Qualify native parser heap aborts from observed evidence

## Status

Accepted, 2026-10-14. Issue #700. Supplements ADR0019.

## Context

Both full3552-test campaign passes succeeded, but native reconciliation rejected a
parser child ending with SIGABRT and no parent kill. Parser memory-ceiling tests
exercise native V8 exhaustion. Node invokes its fatal handler without JavaScript
exit hooks. The old capture lacks the diagnostic evidence to qualify that record.

## Decision

Opt in only guarded parser entries and named fixtures to native heap-abort capture.
Keep caller arguments, permissions, heap ceilings, IPC, output and stream flow intact.
Observe stderr push delivery without installing a data listener or changing encoding.
Retain a bounded64KiB diagnostic prefix internally and publish only the fatal heap
line, line digest, actual stderr byte count/digest and launch/close identity in a
hashed sidecar. Arbitrary parser stderr and document text are not published.

Require explicit unchanged64-32768MiB heap arguments, matching native diagnostics,
matching launch identity and actual SIGABRT or Node exit134 closure. Reject a
JavaScript completion for such an abort. Keep exact source hashes, layouts,
contiguous frames and genuine counter increments mandatory. No completion or hit
is invented; accepted pre-abort execution remains interrupted. Unexplained aborts,
absent evidence, changed identity, wrong heap configuration and changed sidecars fail.

## Consequences

The ordinary suite's intentional memory failures can be measured without weakening
parser limits or pretending that V8 ran JavaScript cleanup. The implementation
supports Windows' native exit code as well as POSIX signals. Actual native CI must
verify Windows; local macOS results cannot substitute for that proof.

Old failed folders remain ineligible. The fatal line is a trusted capture observation
bound to the registered executable and host closure, not a general claim that any
process printing similar text exhausted its heap. The complete campaign must still
meet every original coverage and separate-suite requirement.

References: [Node OOM handler](https://github.com/nodejs/node/blob/v24.21.0/src/node_errors.cc),
[platform abort behavior](https://github.com/nodejs/node/blob/v24.21.0/src/util.h),
[Windows exit134](https://github.com/nodejs/node/blob/v24.21.0/src/node_exit_code.h).
