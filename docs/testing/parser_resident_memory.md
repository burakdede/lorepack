# Parser resident-memory verification

Issue [#677](https://github.com/burakdede/lorepack/issues/677) owns the sampled
parser RSS budget. [ADR 0043](../adr/0043-parser-resident-memory.md) remains
proposed until the full local, packed and native three-platform qualification
passes. A passing sampled maximum is not an atomic peak or a hard memory quota.

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

| CLI workload | Fixture input | Heap MiB | Parse deadline | RSS threshold |
|---|---|---|---|---|
| FlateDecode PDF | 1500 MiB of repeated text operators | 2048 | 30 s | 1024 MiB |
| CMap PDF | Eight ranges of 2^24 codes | 2048 | 30 s | 1024 MiB |
| DOCX | 64 MiB document text | 128 | 30 s | 1024 MiB |
| CSV | 4,000,000 one-character rows | 128 | 30 s | 1024 MiB |

The CSV and DOCX cases retain the original low heap limit. Both memory controls
remain active; a heap exclusion is valid for these cases. The FlateDecode and
CMap cases must report the resident-memory-specific warning. Streaming only
changes fixture construction: small cases must match the existing Flate helper
byte for byte, while the large case avoids a giant JavaScript string in setup.

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
