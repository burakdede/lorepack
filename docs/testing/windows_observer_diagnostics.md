# Windows resident observer diagnostics

Issue #801 tracks the Windows failure retained from PR #800 at `adb86563`:
five accepted RSS reports followed by 813 ms without another accepted report.
The reader had no observed exit or signal. This does not establish why reporting
stopped.

The original rule-semantics regression enables the internal
`LOREPACK_OBSERVER_DIAGNOSTIC=1` setting on Windows. The observer records up to
16 fixed-field events for reader emission, parent receipt, watchdog execution
and reader closure. Reader and parent elapsed times use separate clocks;
ordering across the two pipes is not a total event order. Instrumentation may
affect scheduling.

On an observer failure, the existing error includes the current snapshot.
Reader closure writes one final bounded stderr snapshot so queued diagnostic
events remain visible after test error serialization. Healthy shutdown emits
no final snapshot. The trace contains no source text, paths, arguments or raw
reader stderr.

The diagnostic preserves numeric RSS stdout, 100 ms sampling, the 250 ms
reporting deadline, 5000 ms startup deadline, output caps and fail-closed parser
termination. It does not retry, wait for closure or extend a parser lifetime.

Run the affected parser checks with:

```sh
pnpm exec vitest run --project parsers packages/parsers/test/windows_resident_memory.test.ts packages/parsers/test/resident_memory.test.ts packages/parsers/test/isolation.test.ts
```

The mocked reader checks actual silence, typed failure, cleanup, bounded late
events and healthy shutdown. The Windows-only real PowerShell case blocks the
parent for 800 ms while the reader samples normally, then checks queued report
delivery. It is skipped on other platforms because they use a different
observer. A passing diagnostic regression alone does not explain the historical
failure or close #801. Fresh native execution and causal evidence remain required.

## Startup observation

The later Windows small benchmark at `e75d74e7` failed before the first valid
sample: 5001 ms, no observed reader exit or signal, and zero buffered stdout
characters. Its actual CI merge, `3c59e0d`, has the same tree as `e75d74e7`.
This startup failure and the earlier reporting gap have no established shared
cause. An empty parent buffer does not locate a delay in the reader or parent.

The optional trace also records the reader's parent-observed spawn event,
startup watchdog arm/fire/check, and fixed first-iteration PowerShell milestones:
script entry, refresh returned, RSS read, and before the first stdout write.
Entry precedes process lookup. Milestones use the existing 16-event ring and
final failure snapshot; healthy shutdown still emits no diagnostic line.
The first-sample barrier, numeric stdout and all timing/output limits remain.
Missing or separately delivered markers are inconclusive. The entry marker
follows error-preference and Stopwatch initialization, so it cannot time that
setup or the earlier process startup interval.

The existing benchmark measurement step enables this flag only on Windows;
its commands, corpus, sample counts and scheduling stay intact. Windows timing
reports from this instrumented step are diagnostic evidence, not final
performance qualification. Final performance evidence requires an unchanged
workload without observer instrumentation. No successful replay by itself
explains either historical failure.

The mocked startup control checks silence through the original 5000 ms deadline,
then typed failure and parser/reader termination, bounded late markers and final
closure. It does not execute PowerShell or establish a native failure mechanism.
The existing real PowerShell stall case awaits readiness before stalling and
therefore checks reporting after startup, not startup queue delivery.
