# Windows build-cancellation qualification

Issue #764 retains the native failure from PR #763, Windows job 116822268628.
The real CLI test exceeded its existing 180000ms deadline. The failed log did
not identify the stage, so it does not prove a lock leak or process-tree defect.

The test records stage elapsed times and prints diagnostics only when it fails
or is still running five seconds before its existing deadline:
original and current active build IDs (read-only state query), child PIDs/exit signals,
stream buffering/flow state, the final 16000 characters of available child output,
and the lock owner record (or read error).
Failure capture runs at the start of the existing cleanup hook before children
are killed or the fixture is deleted. A deadline timer emits the same snapshot
before Vitest can interrupt a test that is still pending at its deadline. The
timer is cleared during normal cleanup. All output comes from the disposable
test fixture. The initial dev startup retains its existing connection-block
failure message and output capture.

The recorder uses existing caller-owned output buffers. It adds no stream readers
while the scenario runs. Previously unconsumed pipes are read only when failure
diagnostics are requested. Node documents that [adding a data listener changes
stream flow](https://nodejs.org/download/release/v24.21.0/docs/api/stream.html#two-reading-modes),
so active observation could remove backpressure and hide a stall. A real finite
stderr producer reproduces that observation defect; the passive recorder leaves
it blocked and captures bounded pending output on request. This does not establish
the cause of the original native timeout.

Run the actual built CLI fixture with the repository's pinned toolchain:

```sh
pnpm build
pnpm exec vitest run packages/cli/test/cancellation_diagnostics.test.ts
pnpm exec vitest run packages/cli/test/dev.e2e.test.ts
```

A local pass does not resolve the Windows failure. Retain the complete native
Windows default-suite run on the final integrated head. Keep the 2400 source
files, payloads, timed setup, all cancellation/active-build/rebuild assertions,
180000ms deadline, internal waits, retries, skips and original scheduling.
The diagnostics do not change process signaling or cleanup behavior.

Local verification on 2026-10-16, macOS arm64 and Node24.21: all23original dev
CLI tests and178architecture checks passed, along with lint, format, build,
strict changed-test types and documentation checks. A disposable failing copy
then proved diagnostics capture the live parsing child, matching lock owner
and unchanged active build before cleanup. That injected failure is a diagnostic
probe, not a reproduction or resolution of the native timeout. Its copy was
removed; the original tests and assertions remain intact.

Native failure-stage evidence and root-cause correction remain outstanding.
#578 separately owns Windows MCP .cmd descendant cleanup.

The deadline snapshot is tested with fake timers: it runs before the unchanged
180000ms cutoff and can be cancelled when the real-process test completes.

On 2026-10-17, macOS arm64 / Node 24.21.0: the passive recorder passed two
real-process controls, all 25 current dev cases, strict Node-only test types,
181 architecture checks and static/documentation checks. A disposable copy
injected failure after the original parsing checkpoint and confirmed the live
child, matching lock owner and unchanged active build before cleanup. The copy
was removed and source fingerprints matched before and after the probe. This
proves diagnostic wiring, not the cause or resolution of the native timeout.
