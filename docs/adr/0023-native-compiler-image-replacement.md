# Authenticate native compiler image replacement

## Status

Accepted, 2026-10-14. Issue #700. Supplements ADR 0019.

## Context

Both complete campaign test passes succeeded, but six TypeScript 7 compiler
launches had started-only counter streams. The Node shim calls `process.execve`
on POSIX. Image replacement retains the PID but discards the JavaScript runtime
without firing exit hooks. Normal host close cannot prove a JavaScript exit.

## Decision

Record the real image-replacement attempt before calling the original API without
changing arguments, environment, permissions or process identity. Every active
counter namespace receives its own identity-bearing frame. If the call returns
or throws, record that fact and require ordinary lifecycle evidence afterward.

Qualify a final handoff only for the canonical installed native TypeScript
compiler, with matching executable bytes, pinned compiler/platform package
versions and observed same-PID/thread host closure. Keep its counter state
`replaced` and JavaScript exit code absent. Preserve the actual host exit code
separately. Reject unregistered images rather than assuming their owned execution
was observed. Keep existing source, sequence, increment and interruption checks.

## Consequences

Real pre-handoff owned counters remain usable without replacing execve with a
subprocess or inventing completion. Old started-only campaigns remain invalid.
The allowlist covers the native compiler, which produces JavaScript artifacts
without executing owned JavaScript. Other replacement images need their own
capture contract before qualification. This bounds collection to the measured
Node image; it is not a general native-code coverage claim.

POSIX regressions execute the actual API and compiler, compare exact owned hits,
reconcile launch/close receipts and reject absent closure, wrong identity, stale
executable hashes, unregistered images and missing handoff frames. Windows and
IBM i skip those regressions because Node does not support execve there.

Reference: [Node process.execve](https://nodejs.org/docs/latest-v24.x/api/process.html#processexecvefile-args-env).
