# Windows

**Windows 11 x64 is a supported target** (architecture 5.3), tested on every commit in the
same CI matrix as macOS and Linux.

There is no Windows code path. Architecture 12.11 states the rule the whole platform story
rests on:

> **Internal identifiers are POSIX. Filesystem calls are native.**

Every Windows defect found so far came from mixing those two up, and none of them looked
like a path problem from the outside.

## What that rule buys

| | Spelling | Why |
|---|---|---|
| Artifact ids, chunk ids, build inputs | POSIX, always | A build id must be identical on every platform, so identity cannot see a separator |
| `display_path`, printed output | native | It is meant to be read and pasted into the reader's own shell |
| Filesystem calls | native | The operating system is the one being asked |

## Things that bit us, written down so they do not bite twice

### libuv aborts on an 8.3 short path

`%TEMP%` under a long user name is a short path (`C:\Users\RUNNER~1\AppData\Local\Temp\...`).
Handing that to the watcher kills it:

```text
Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72
```

libuv compares the long name the operating system reports against the short name it was
asked to watch, they do not match, and the process takes an assertion failure. Nothing
recovers, because there is no watcher left. The project root is therefore resolved with
`realpathSync.native` before chokidar sees it.

### A parent process cannot ask a child to stop gracefully

Windows has no POSIX signals. `child.kill('SIGTERM')` is emulated with `TerminateProcess`,
so the handler never runs and a supervisor that did everything right dies non-zero.

**A user pressing Ctrl-C is unaffected**: that path goes through a console control handler
and does reach the process, so `lore dev` cleans up normally for the person running it.

The consequence is for tooling and tests, not for users: a hard kill leaves a `.lore/dev.json`
naming a dead pid, and the next `lore dev` clears it. That is precisely why the receipt is
evidence rather than a lock.

Tests that stop a supervisor from a parent use SIGTERM where a graceful stop is being
asserted, and skip those assertions on Windows with this reason.

### Filesystem events are not reliable

Windows CI delivered no usable event for an ordinary append. A watcher whose correctness
depended on the event stream went on serving the previous build indefinitely. That is why a
periodic reconciliation runs underneath it (architecture 12.3): the stream accelerates, the
sweep guarantees. See [watch mode](../architecture/watch.md).

### A killed process holds the build database open for a moment

Removing a temporary directory immediately after a child exits fails with `EPERM` on Windows
and passes everywhere else. Tests wait for `exit` and treat a leaked temp directory as
acceptable rather than as a failure.

## Case-only collisions

Two files differing only in case are one file on Windows and on a default macOS volume, and
two on Linux. Left alone, the same corpus would build differently depending on the machine,
so discovery refuses the collision and names both paths (architecture 10.6).

## Generated client commands

Commands are an executable plus an **argument array**, never a concatenated string
(architecture 6.6 step 7). A client spawns them directly, so quoting is not a problem it has
to solve.

The copy-paste snippet is different: it is meant for a shell, so both forms are rendered and
quoted for their own rules. Windows backslashes are literal except before a quote, and a
trailing run before the closing quote must be doubled, or `CommandLineToArgvW` reads the
quote as part of the argument.

## Running the suite

```bash
pnpm vitest run --project cli windows
```

Most of it runs on every platform on purpose: a separator rule that only holds on Windows is
one nobody notices breaking until the Windows job runs.
