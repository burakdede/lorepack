# Watch mode

How `lore dev` notices a change, and why the watcher is never allowed to be the reason it
believes one happened.

## The watcher is an accelerator, not the truth

Architecture 24.5 states it and 12.11 encodes it: filesystem events are a hint that
something *may* have changed, and **content hashes decide whether anything did**. Every
event is treated as a reason to go and look, never as evidence of what was found.

This matters because every part of the event stream is unreliable in a way that is normal
rather than exceptional. One save is several events. An atomic-rename save is a delete
followed by a create. A chunked write produces a file that exists and is incomplete. A
touch produces an event and no change at all. A file written between the initial scan and
the watcher becoming ready produces no event, ever.

So losing an event costs a slower rebuild. It cannot cost a wrong one.

## The sequence

| Step | What happens | Why it is there |
|---|---|---|
| 1 | The initial scan | It is the build `lore dev` already ran |
| 2 | Start the watcher | |
| 3 | **Reconcile once ready** | A file written in the gap belongs to neither the scan nor the stream |
| 4 | Coalesce events for a debounce window | One save is many events |
| 5 | Wait for size and mtime to hold still | A hash taken mid-write is a real hash of the wrong bytes |
| 6 | Fingerprint the content | The deciding evidence |
| 7 | Stop if the content is unchanged | A touch, or a rename of identical bytes |
| 8 | Build a candidate | |
| 9 | Activate only after validation | `runBuild` already guarantees this |

Step 3 is the one that looks redundant and is not. Steps 1 and 2 cannot be made atomic, so
there is always a window, and a file that lands in it would otherwise stay invisible until
something unrelated touched it.

**Underneath all of it there is a periodic sweep** (architecture 12.3), which prescreens on
paths, sizes and modification times every couple of seconds and settles only when that
signature moved. It is not belt and braces. Windows delivered no usable event for an
ordinary append in CI, and a watcher whose correctness depended on the stream went on
serving the previous build until the test gave up. The stream accelerates; the sweep
guarantees. A platform that delivers events promptly pays a directory scan every couple of
seconds and finds nothing.

Step 7 is visible rather than silent. A save that changes nothing prints `No changes: the
sources still match the active build`, because a user who saved and saw nothing happen is
owed the reason.

## One matcher, not two

The watcher decides which events matter using `createSourceMatcher`, which is the same
function discovery uses to decide which files are sources. Two matchers built from the same
ingredients in two places is exactly how they come to disagree about one file, and the
symptom would be a file that is indexed but never triggers a rebuild, or the reverse.

Chokidar is given a **directory**, never a glob: v4 removed glob support and v5 has not
brought it back. Patterns are ours to apply.

## Failure is survivable

A rebuild that fails leaves the previous build active and prints why (architecture 6.9).
Serving the last good build is recoverable; exiting the supervisor in the middle of
someone's session is not.

A rebuild superseded by a newer change is aborted rather than finished and discarded. The
build it was producing answers a question that is already out of date, and `runBuild`
removes its own incomplete candidate, so activation never sees it.

A watcher that errors triggers a reconciliation scan and says so. Recovery re-establishes
truth from content, because the stream has just proved it cannot be trusted.

## Freshness comes from the watcher

`lore serve` has no idea whether the sources moved, so it polls on an interval with a
metadata prescreen. A supervisor that is already watching the filesystem **knows**, so
`lore dev` hands the server `watching.freshness()` instead, and the interval scan does not
run at all. That is the hook #112 named, and it is an injection into `startServing` rather
than a second server.

## The dev session, and why the receipt is not a lock

`lore dev` writes `.lore/dev.json` once it is serving, recording the port, pid, start time,
active build and host. Architecture 15.3 fixes the file and the preferred port, `43110`,
which is deliberately not `lore serve`'s: a dev session and a read-only server are different
things and someone may want both at once.

The receipt is **evidence about a process, never a lock**, and the distinction decides the
behaviour:

| Situation | What happens |
|---|---|
| A receipt naming a live process | The second `lore dev` refuses, naming the port and pid of the one already running |
| A receipt naming a process that is gone | Cleared without comment, and the new session starts |
| A receipt that is corrupt or not JSON | Treated as absent |
| A clean stop | Removed |

A lock that outlives what it protects makes a crash unrecoverable without deleting a file
nobody mentioned. Checking the pid every time means a machine that lost power costs nothing.

Refusing the second session is worth doing rather than racing: two supervisors on one
project would both watch, both rebuild, and take turns failing to acquire the build lock,
and what a user would see is a server that intermittently stalls for reasons nothing
explains.

## Stopping

On SIGINT or SIGTERM, in this order, inside a ten second bound:

1. **the watcher**, so a rebuild in flight is cancelled and its candidate discarded while
   activation still points where it did;
2. **the server**, which stops accepting and drains what is already in flight;
3. **the databases**, because a request still running would otherwise reach a closed handle;
4. **the receipt**, unconditionally, even if a step above timed out.

The bound exists because a wedged request must not hold the process open forever. Ctrl-C
ends the session; it does not promise to wait indefinitely for a socket that will never
close.

**Windows has no POSIX signals.** A parent's `kill('SIGINT')` is emulated with
`TerminateProcess`, so the handler never runs and the supervisor dies non-zero having done
nothing wrong. Ctrl-C typed into a console still works, because that path uses a console
control handler. Tests that stop a supervisor from a parent process use SIGTERM, which
reaches the handler everywhere this ships.
