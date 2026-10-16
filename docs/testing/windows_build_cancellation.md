# Windows build-cancellation qualification

Issue #764 retains the native failure from PR #763, Windows job 116822268628.
The real CLI test exceeded its existing 180000ms deadline. The failed log did
not identify the stage, so it does not prove a lock leak or process-tree defect.

The test records stage elapsed times and prints diagnostics only on failure:
original and current active build IDs (read-only state query), child PIDs/exit signals,
the final 16000 characters of each child's captured output, and the lock owner record (or read error).
Capture runs at the start of the existing cleanup hook before children are
killed or the fixture is deleted. Vitest onTestFailed runs after cleanup and
cannot inspect that original state. All output comes from the disposable
test fixture. The initial dev startup
retains its existing connection-block failure message and output capture.

Run the actual built CLI fixture with the repository's pinned toolchain:

```sh
pnpm build
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
