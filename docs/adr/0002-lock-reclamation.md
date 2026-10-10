# Reclaim project locks by recorded identity

## Status

Accepted.

## Context

Removing a lock by its path after deciding it is stale can delete a replacement owner's
lock. PID reuse and locks copied from another host also make PID-only liveness unreliable.
Lorepack must preserve mutual exclusion without native add-ons or installation prerequisites.

## Decision

Record the operating system hostname, process start identity and a UUID ownership token.
Never reclaim foreign-host locks automatically. Keep a live owner's lock when its start
identity cannot be inspected. Use absolute system executable paths for process probes.

Rename a stale lock to a nonempty tombstone named from the identity that was judged stale.
Competing renames to that same tombstone fail, preventing a late reclaimer from moving a
replacement lock. Check the moved identity before acquiring a replacement. Keep tombstones
for one hour before sweeping them during later acquisitions.

## Consequences

Lock acquisition requires no native dependency. Real concurrent-process tests exercise the
same directory operations used by builds, activation and prune on all supported platforms.
Foreign-host locks require manual cleanup after confirming that their owner stopped.

Protection against delayed reclaimers lasts only while their tombstone remains. A process
suspended for more than one hour between judging and renaming can exceed this guarantee.
The process-start comparison also has a five-second tolerance on macOS and Windows because
their wall-clock probes have lower precision than Linux's exact start ticks.
