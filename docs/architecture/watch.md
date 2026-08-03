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
