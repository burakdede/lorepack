# Source freshness recovery verification

Issue #586 keeps `lorepack dev` alive when a source disappears between discovery and
fingerprinting. No build failure is converted into a successful candidate; serving continues
from the selected immutable build with honest freshness.

## Deterministic read-open race

`packages/cli/test/watch_freshness_failures.test.ts` calls the real compiler fingerprint
function after moving a discovered artifact away. The actual filesystem open fails, then
the file is restored with its bytes, size and mtime preserved. No invented source error is
used. The initial run on main109a2b94 failed three cases: read-only freshness rejected,
the watcher queue failed to recover and startup readiness did not settle. One unrelated-error
control passed. The first correction passed these cases plus existing freshness tests.

The final fixture also checks that strict status still reports `LORE_E_SOURCE_UNREADABLE`
and unexpected errors still propagate outside the supervisor. A separately injected unexpected
scanner failure tests the supervisor recovery boundary rather than masquerading as an IO race.

## Real CLI churn

The existing dev CLI fixture supplies one runbook and adds299stable documents, for300total.
For the full60000ms it repeatedly creates and removes20temporary Markdown files. A separate
reader loop asks HTTP and the same persistent MCP HTTP client for results while writes
continue. It then creates one stable cited source and requires a new active build, clean
freshness and matching HTTP/MCP locators, with the original dev process and receipt still live.
The client uses protocol SDK2.2.0 pinned to MCP2026-07-28. No production interval, existing test
deadline, retry, skip, assertion or suite scheduling is changed.

```sh
pnpm build
pnpm exec vitest run packages/cli/test/watch_freshness_failures.test.ts packages/cli/test/freshness.test.ts packages/cli/test/watch.test.ts packages/cli/test/status.test.ts packages/cli/test/dev.e2e.test.ts
```

Observed on 16 October 2026, macOS arm64, Node24.21.0: the expanded five-file
suite passed all73tests, including the full sixty-second churn, concurrent HTTP/MCP
reads, recovery and strict-error controls. Build, strict changed-test types, lint and
format checks also passed on that unchanged source. This scoped result is not full
current-source or native qualification.

## Real permission failure

A separate actual CLI check ran under a non-root POSIX account. After initial activation,
`chmod 000 b.md` and an edit to `a.md` produced the warning
`Source freshness is unknown: b.md could not be read.` The same dev process stayed alive,
HTTP reported unknown freshness and the previous build still served the cited `b.md`
content. Restoring the original mode, without changing `b.md` bytes or mtime, allowed
reconciliation to activate the changed `a.md` and return to clean freshness.

To repeat, use a disposable two-document project, start `lorepack dev`, record
`GET /v1/build`, remove read permission from one file and edit the other. Confirm the
warning, unknown freshness, unchanged active build and successful cited search. Restore
the mode and confirm a new clean build and both documents remain searchable. Restore
permissions and stop the process before deleting the fixture. Run this check as a normal
POSIX user; root may still read mode000files. Windows ACL behavior needs native evidence.

These results are not external desktop-client trust verification or Windows `.cmd`
descendant-cleanup proof. Record full current-source and native results before closure.

## Combined source-policy recovery verification

The combined source-root, project-root rule and read-recovery branch adds a real
`docs` directory-source case with no filesystem events. It establishes the floor
baseline, induces a fingerprint-read failure while retaining the file's bytes,
size and modification time, then requires unknown state, preservation of the
previous build and a clean rebuilt version after recovery. Excluded edits remain
excluded and the event timestamp remains absent.

On macOS with Node 24.21.0, the first combined cohort passed 363 cases and failed
the existing unsupported-file event/no-op case. Chokidar recorded no raw directory
event, while the existing-file control received one. A separate bare Node
`fs.watch` comparison likewise observed an existing-file event but no directory
event in the default scratch location during its observation window. Under
`/tmp`, directory events arrived and all 18 unchanged watcher cases passed.
This establishes an environment-dependent observation, not a proven OS cause.

Further local integration uses `TMPDIR=/tmp` explicitly. No event, no-op or
recovery assertion, timeout, reconciliation interval, workload or test scheduling
is changed. The default-scratch failure remains recorded and native CI must
qualify the combined branch before closure.

The combined scoped campaign passed all 364 integration cases across 16 files,
all 178 architecture cases, build, strict changed-test types, lint, formatting and
product types on 16 October 2026 (macOS arm64, Node 24.21.0, TMPDIR=/tmp).
The actual combined CLI check also passed: excluded-only edits kept the same clean
build, public and negated-source edits activated a new clean build, and HTTP plus
the same connected MCP client returned matching line-3 locators. Excluded markers
stayed absent and no watcher error was emitted. This is scoped local evidence;
full and current native qualification remain required.
