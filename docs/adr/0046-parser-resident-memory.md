# Observe parser resident memory outside the parser

## Status

Accepted on 2026-10-17 for issue #677. Production enforcement, full local and
packed verification, and the original three-platform CLI workloads passed at
`0d946812829fd87e9972068fe9efb5f1c2bf8e74`. The Windows startup grace was
superseded by [ADR 0048](0048-windows-observer-startup-grace.md). Other measured
limits below remain part of this decision.

## Context

[ADR 0001](0001-parser-process-isolation.md) isolates parser crashes and bounds
wall time and the V8 heap. It does not constrain native buffers or total RSS.
The actual bundled CLI on main c51c8acb parsed a 1,081-byte eight-range CMap PDF
under the unchanged 2,048 MiB heap and 30-second timeout. External 200 ms samples
observed 3,029,872 KiB of parser-child RSS before the timeout. The parent survived
and the active build stayed unchanged. Raw evidence is recorded in issue #677.

[Node's memory documentation](https://nodejs.org/download/release/v24.21.0/docs/api/process.html#processmemoryusage)
distinguishes V8 heap, external buffers and process RSS.
[Worker limits](https://nodejs.org/download/release/v24.21.0/docs/api/worker_threads.html#new-workerfilename-options)
exclude external buffers. A trusted worker could observe its entire process,
but preserving the parser's existing worker restriction would require revoking
its startup grant before loading parser code.
[Permission revocation](https://nodejs.org/download/release/v24.21.0/docs/api/process.html#processpermissiondropscope-reference)
was added in Node 24.20.0. It cannot support the agreed Node 24.19 minimum.
Do not raise that minimum or silently broaden parser permissions for this fix.

A separate observer stopped the same unchanged CLI child at a 1,024 MiB RSS
threshold. With 200 ms sampling it observed 1,198,608 KiB before termination,
146.52 MiB above the threshold, within the probe's predeclared 1,536 MiB envelope.
The CLI finished in 4.689 seconds and preserved the active build. This probe
used the old crash classification; it is not a production memory diagnostic.
The sample maximum is not an atomic peak or a universal overshoot bound.

## Decision

Keep the parser child and every existing child permission flag unchanged.
Observe its resident memory from the unblocked parent using OS facilities:

- Linux: read `Rss` from `/proc/<pid>/smaps_rollup`. The
  [kernel documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
  defines its totals across process mappings. Avoid the documented approximate
  accounting of `status`/`statm` when a rollup is available on the supported OS.
- macOS: invoke the system `/bin/ps` for only the owned parser PID. The installed
  `ps(1)` manual defines `rss` in 1,024-byte units. Serialize observations so
  command latency cannot create overlapping observers.
- Windows: use the OS-provided Windows PowerShell 5.1 process query, with profiles
  and interaction disabled. A persistent bounded numeric stream avoids starting
  PowerShell for every sample. Use the local numeric-PID overload of
  [Process.GetProcessById](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.getprocessbyid),
  `Refresh`, and .NET sleeping/output methods, avoiding cmdlet module auto-loading. [WorkingSet64](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.workingset64)
  reports resident bytes. No PowerShell 7 installation is required.

Use a separate operational RSS threshold, default 1,024 MiB, with validated
`LORE_PARSE_RSS_MB` override. Preserve the existing heap and timeout controls.
A programmatic RSS override is optional so existing `ParseLimits` callers keep
working. The intended observation interval is 100 ms. Numeric values, PID and
observer output must be bounded and validated. No source path enters a command.

Require a first valid memory observation before dispatching input. Keep one
observer per reusable child, including across jobs, rather than imposing
Windows process startup on every document. On a threshold breach, kill that
owned child, drain its pipes/observer, and return a located `parse-memory`
resource exclusion with RSS-specific remediation. Replace it for subsequent
work. Observer failure must stop parsing with a typed failure, not silently
turn enforcement off or falsely report a measured threshold breach.

Stop every observer on parent shutdown, parser exit, timeout and cancellation.
The child forbids descendants, so the parser subprocess tree is one process;
measure observer and CLI overhead separately as well as the whole owned tree.
Operational RSS readings and timings never enter canonical build identity.
Warnings use the existing exclusion/provenance flow. The documented no-op
attempt-warning limitation remains tracked separately in #662.

## Consequences

A sampled watchdog terminates excessive resident use even when parser code is
blocked. It is not a kernel allocation quota: large allocations, observer latency
and OS scheduling can overshoot the threshold. Do not advertise a hard RSS ceiling.

The original four mandatory CLI workloads must demonstrate the predeclared
1,536 MiB observed parser-tree envelope at the default 1,024 MiB threshold on
all three supported platforms. Preserve raw independent observations, workload
hashes, original deadlines, parent survival and active-build/lock assertions.
A failed envelope is a failed gate requiring investigation, not a reason to
raise the target after the run. Record native overshoot and sampling limitations
before accepting this ADR; the macOS probe alone cannot establish them.

OS readers add measurement overhead. Verify first-run and no-op behavior,
process cleanup, packed closure and existing performance gates. Reader failure
is visible to users; no extra runtime, account, compiler or native add-on is
introduced. Public documentation describes the sampled control and links the source-bound native
measurements. Acceptance does not establish a hard RSS ceiling.

### Privacy-proof integration

The parent adds fixed read-only OS processes on macOS and Windows. No source path
or source text enters their commands. The privacy preload admits only the exact
command and options for a live parser PID already admitted under the unchanged
child permission checks. It rejects other PIDs, altered scripts, shell options and
observer calls from inside the parser. All original network/process denial probes
and Node grants remain unchanged. Linux reads procfs without another process.

On 2026-10-17, macOS arm64 / Node 24.21.0: the new native-growth regression
first reported `parse-timeout` instead of `parse-memory`. After implementation,
52 parser/CLI tests passed, including the unchanged isolation fixtures, replacement,
cancellation and no-op identity checks. The privacy/policy run passed 14 tests,
including the actual seven-format build and five unauthorized observer attempts.
The Windows startup-failure unit probe is Windows-only; all resource fixtures remain
mandatory on every platform. These tests do not replace independent actual-CLI
resource measurements, packed qualification or the three-platform matrix.

The [resource verification protocol](../testing/parser_resident_memory.md) defines
mandatory actual-CLI cases and independent process-tree sampling. Its Windows
measurement uses [Win32_Process](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)
CIM properties, independently of the production .NET process observer. Current
macOS samples passed the predeclared observed envelope. Subsequent clean-source
full, packed and three-platform qualification is recorded below.

A reporting-health timer must allow pending I/O to run before inferring observer
failure after a parent stall. The [Node event-loop documentation](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick)
distinguishes timer and poll phases. A real live-pipe reproduction failed with
the original timer-only decision and passed after a `setImmediate` check turn.
This preserves the 250 ms health deadline and immediate RSS-breach termination;
it is not a larger memory envelope or a retry. Native failures remain unqualified
until their unchanged scenarios pass with retained diagnostics.

The same ordering applies to the first observation: the five-second startup
deadline must service pending I/O before declaring the reader unavailable.
A real first-report pipe reproduces the timer-only false failure after a parent
stall, while a silent-reader control still expires. Startup failure diagnostics
retain elapsed time and bounded reader state. The native Windows benchmark
failure on `c44dde1c` remains failed until fresh qualification confirms the
correction; no startup deadline or original benchmark workload is increased.

Linux PID presence is insufficient to infer a live address space. The kernel's
[smaps rollup implementation](https://github.com/torvalds/linux/blob/v6.8/fs/proc/task_mmu.c#L879)
returns `ESRCH` when the task or memory descriptor disappears. Native Linux exposed
this before Node delivered child-close, replacing a heap-memory exclusion with an
observer error. Treat only that errno from the fixed owned-process procfs read as
an exit signal: stop sampling and await the existing close/stderr classification.
Other errors remain failures, and no sample, retry, budget or deadline is changed.

## Native qualification, 2026-10-17

The [measurement report](../testing/evidence/parser_memory_0d946812.json) records
all 24 actual-CLI cases: two complete four-fixture cohorts on each OS, with exact
fixture hashes, controls, source/bundle identity and artifact archive digests.
The clean CI merge `297ef0293a75bea23326b4363fbad07b6733b114` has the same Git
tree as the candidate above. All platforms used Node 24.21.0.

| Platform | Architecture | Largest sampled parser RSS |
|---|---|---|
| macOS | arm64 | 1020.453125 MiB |
| Linux | x64 | 1052.64453125 MiB |
| Windows | x64 | 1025.7421875 MiB |

These maxima passed the predeclared 1536 MiB observed envelope at a 1024 MiB
operational threshold. Linux and Windows samples demonstrate overshoot; the
macOS maximum below the threshold does not establish its absence. Independent
snapshots wait 100 ms after each completed query and can miss larger allocations
between queries. They establish neither atomic peaks nor a universal overshoot
bound. DOCX ZIP timestamps vary, so each actual compressed fixture hash is kept.

The [native CI run](https://github.com/burakdede/lorepack/actions/runs/38995956578)
passed full verification, acceptance, clean/packed installs and credentialed
Cloudflare acceptance. Original CLI assertions verify typed located exclusions,
active and retained builds, no-op identity, lock removal and owned-process cleanup.
All three original small benchmarks also passed in the
[benchmark run](https://github.com/burakdede/lorepack/actions/runs/38995956566).
This closes the resident-memory qualification at the recorded source, not the
separate cancellation investigation, coverage targets or final release gates.
