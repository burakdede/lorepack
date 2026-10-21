# Parser resident-memory verification

Issue [#677](https://github.com/burakdede/lorepack/issues/677) owns the sampled
parser RSS budget. [ADR 0046](../adr/0046-parser-resident-memory.md) records the accepted sampled
control and its limits. The [three-platform measurement report](evidence/parser_memory_0d946812.json)
retains source-bound qualification for the original four workloads. A passing
sampled maximum is not an atomic peak or a hard memory quota.

Run from the repository root, with Node 24.21.0:

```sh
pnpm build
pnpm exec vitest run tools/test-support/test/hostile-fixtures.test.ts packages/cli/test/resident_memory.e2e.test.ts
pnpm exec vitest run --root tools/security test/security-coverage.test.ts
```

The consolidated suite requires all four CLI cases to run and pass. None is
platform-conditional. The Windows observer-startup unit probe is required on
Windows and explicitly inapplicable on Linux/macOS. Original isolation,
cancellation, identity and privacy probes remain unchanged.

The Windows reader has a bounded 15000 ms startup grace. Isolation sends no
source bytes to the parser until the first valid RSS sample arrives. This
accommodates delayed PowerShell startup without changing the parser memory
envelope or the 250 ms reporting deadline.

The actual macOS `ps` parent-stall regression runs only on macOS, where that reader
is used. All shared real-process output, failure and timeout controls run on every OS;
the original four CLI memory workloads remain mandatory on every OS.

The macOS reader retains malformed output as a JSON-escaped literal in its error.
The fixed `/bin/ps` query keeps its existing 256-byte output limit and 250 ms deadline.
Numeric interpretation, including zero and outer whitespace, remains unchanged.
All-platform unit controls verify these cases and escaped malformed reports. A retained
value supports diagnosis; it does not by itself establish why the OS returned it.

## Completed macOS reports under parent load

Node 24.21.0's `execFile` timeout destroys its output streams before killing the
reader. A real `ps` probe with the existing 250 ms timeout and a 500 ms blocked
parent returned empty output with exit code zero in eight trials, despite a live
target process. The actual monitor regression reproduced the same typed failure.
This establishes a completed-output loss mechanism; earlier malformed-report logs
did not retain enough timing to attribute each historical failure individually.

The macOS query now uses `spawn` with the same 250 ms timeout and `SIGKILL`, then
drains both pipes through close with the same 256-byte per-stream limit. A completed
report stays available when the parent's timeout callback is delayed. Numeric zero
and malformed/empty rejection are unchanged. Real subprocess controls retain nonzero
exit, spawn error, hung-reader and ASCII/UTF-8 overflow failures. There is no retry,
new permission, longer deadline, or larger memory budget.

The privacy proof admits only the fixed query for an already-owned live parser PID.
It rejects the retired `execFile` form and altered PID, arguments, shell, timeout
and signal. These checks preserve the parser's existing restrictions and all old
denial probes. This does not resolve the separate Windows reporting failure.

| CLI workload | Fixture input | Heap MiB | Parse deadline | RSS threshold |
|---|---|---|---|---|
| FlateDecode PDF | 1500 MiB of repeated text operators | 2048 | 30 s | 1024 MiB |
| CMap PDF | Eight ranges of 2^24 codes | 2048 | 30 s | 1024 MiB |
| DOCX | 64 MiB document text | 128 | 30 s | 1024 MiB |
| CSV | 4,000,000 one-character rows | 128 | 30 s | 1024 MiB |

The CSV and DOCX cases retain the original low heap limit. The original CSV
input now receives a typed row-limit refusal and a cited fallback artifact. The
same measured build also includes an admitted 500,000-row, eight-column numeric
CSV (`rows_memory.csv`) to exercise the independent heap backstop. Both exact
input hashes are retained. The original case, CLI call count, deadlines, memory
limits, process cleanup and immutable-build assertions are unchanged. The record
must contain exactly the row refusal and the separate memory exclusion. Sampled
process-tree RSS covers the whole build, not independently attributable per-file
peaks. DOCX still proves its original heap exclusion; FlateDecode and CMap must
report the resident-memory-specific warning. Streaming only changes fixture
construction: small Flate cases match the existing helper byte for byte, while
the large case avoids a giant JavaScript string in setup.

Each case drives `public-entry.js`, inspects the typed warning through the CLI,
checks the new active build, verifies the previous manifest is unchanged, checks
lock removal, and repeats the build to verify no-op identity. The changed ordinary
document deliberately creates a new candidate so its located warning is sealed.
It does not hide the separate no-op warning-persistence limitation in #662.

An independent test observer starts before the CLI. It uses full process-table
RSS snapshots on POSIX and `Win32_Process` CIM snapshots on Windows, without
importing the production observer. It retains only the CLI's owned process tree,
separating parser, CLI and OS-observer memory. Observations are serialized, with
100 ms after each completed snapshot. Missing parser observations, observer
failure, remaining owned processes, or an observed parser maximum above the
predeclared 1536 MiB envelope fail the case. Samples can miss allocations and
threshold crossings between observations; they do not establish a universal
overshoot bound.

Raw evidence is written before assertions to
`coverage/parser-memory/<test-pid>/<fixture>.json`. Each file carries fixture
size/hash, source revision and dirty flag, CLI bundle hash, Node/platform,
controls, raw owned-process samples, exit/stdout/stderr and sampled maxima.
Existing native verify jobs upload this directory inside their `test-results-*`
artifacts on success or failure. Dirty-source development receipts are diagnostic;
release qualification requires the final committed source and all three OS jobs.

Manual review must confirm all four files on each OS, exact source/bundle custody,
typed located warnings, parent survival, retained-build integrity, lock cleanup
and process cleanup. Then run the original full verification and packed CLI gates.
Do not raise the observed envelope or alter workloads after a failing run.

## Observer scheduling regression

The first Windows native acceptance run at `7ac0d44b` failed four ordinary
scenarios because the 250 ms reporting watchdog declared the observer stale.
A separate real-pipe test reproduces a parent event-loop stall leaving reports
pending when that timer runs. The check now services one I/O turn before
classifying silence, and cancels the stale check when a newer report arrives.
The 250 ms deadline, 100 ms observations, memory threshold and fixture envelope
are unchanged. Observed RSS breaches still terminate immediately; they never
wait for this health check. A genuinely silent reader must still fail, and
stopping its watchdog must prevent late data from rearming it.

This local reproduction and correction do not prove every native failure had
the same cause. Retain native timing/report-count/reader-state diagnostics and
rerun the unchanged Windows acceptance scenarios before declaring it resolved.
The consolidated suite preserves the child reporter's failed assertion messages,
so a deadline-test failure includes its actual assertion rather than only its status.
The silent-reader test keeps its 350 ms observation and 250 ms minimum silence
assertion, then services the queued check phase before inspecting the callback.
A separate 500 ms parent-stall regression fails without that synchronization.
Node documents that [`setImmediate` callbacks run after I/O callbacks](https://nodejs.org/api/timers.html#setimmediatecallback-args).
This corrects a reproduced test-ordering race; the assertion details from earlier
failed runs were not retained, so their precise failure is still unproven.

## First observer report

The small Windows benchmark on `c44dde1c` failed because the observer did not
become ready within the existing five-second startup deadline. The completed
job log is retained in issue #677. Startup still used a timer-only decision.
A real-pipe regression confirms that a report written within that deadline can
remain pending while a parent stall lets the timer declare failure first.
The separate silent-observer control still fails after the original deadline.

Startup now services the pending I/O turn before classifying a missing first
report, and the first valid sample cancels that decision. The Windows startup grace is now 15000 ms; the 250 ms reporting
deadline is unchanged. A genuine startup failure records
elapsed time, reader PID/exit/signal, buffered length and bounded observer stderr.
This reproduction does not prove every native startup failure has that cause;
the original Windows benchmark and all native resource checks must pass afresh.

## Linux address-space teardown

The original low-heap CMap CLI case failed on native Linux at `7155fb4f` because
`/proc/<owned-pid>/smaps_rollup` returned `ESRCH` before the child-close event.
A PID can still be present after its address space disappears. The reader now
recognizes that kernel exit signal, stops sampling without retrying, and leaves
the existing child-close/stderr classifier to report the original resource exit.
Zero RSS is still a measurement. Permission errors, other I/O errors and malformed
reports still fail closed while the parser is live.

The Linux-reader boundary tests run on all OS hosts using explicit syscall-result
fixtures from this failure; they do not claim native Linux execution. All original
actual-CLI workloads and their controls remain mandatory on native Linux as well
as macOS and Windows. Fresh native qualification must confirm the unchanged case.

## Current-main integration, 2026-10-17

The existing correction is rebased onto main `bd97e971`. All 28 issue-specific
files other than README retain their exact `668bb267` bytes before this
documentation update. The README keeps its concise layout and links to the
resource controls. Current-source verification must run afresh.

The earlier native Windows job lost runner communication during the default
suite. Its job log endpoint returned 404, and the retained workflow archive has
no Windows verification log. That is a failed qualification with an unproved
cause, not a demonstrated parser assertion. Linux and macOS provided 16 trials
on that earlier source; Windows's eight trials are still missing. None of those
receipts qualifies this newly integrated candidate.

Preserve all four actual-CLI fixture workloads and their two attempts, original
1,024 MiB threshold, 1,536 MiB sampled envelope, 100 ms cadence, 15000 ms Windows
startup grace and 250 ms reporting deadline, 256-byte reader bound, permissions,
preloads, scheduling and assertions. Native publication waits for the shared
Windows release-policy setup correction in issue #762 and its real main
integration. Current local, installed-package and native results remain pending.

## Windows build-worker environment

Native PR780 head `4a1cccb8` failed background builds because the observer read
only `process.env.SystemRoot`. Windows worker threads copy environment names
case-sensitively, so an inherited `SYSTEMROOT` was invisible to that lookup.
Resolve the Windows variable name without case sensitivity, then require the
same absolute path before selecting system PowerShell. Missing, empty and
relative values still fail closed; no guessed directory or PATH lookup is used.

The cross-platform observer regression covers four key spellings and three
invalid environments. The original background-build and dev cases remain
mandatory on native Windows. See [Node process environment semantics](https://nodejs.org/api/process.html#processenv).
