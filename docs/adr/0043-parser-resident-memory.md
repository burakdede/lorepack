# Observe parser resident memory outside the parser

## Status

Proposed for issue #677. The baseline and macOS feasibility probe are measured;
production enforcement and Linux/Windows qualification remain incomplete.

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
  PowerShell for every sample. [Get-Process](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/get-process?view=powershell-5.1)
  exposes process memory; [WorkingSet64](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.workingset64)
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
introduced. Current public documentation must keep describing the heap-only
implementation until enforcement and its qualification are complete.
