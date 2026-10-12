# Local read ownership during retention

## Status

Accepted for the local primitive, 2026-10-12. Part of #439 and audit F09.
Remote coordination remains unfinished.

## Context

An open SQLite handle survives POSIX unlink, but its normalized objects do not. Pruning
A after B activates broke200 captured source reads. On Windows even an idle cached
SQLite connection can prevent deletion, so protecting only active request bodies is too narrow.

## Decision

Reuse ProjectLock for a short guard shared by reader registration and final cleanup.
Publish an atomic per-owned-handle record with token, host, PID and native process-start
identity. The guard is released before retrieval; activation can proceed with readers alive.
Protect every referenced build and its objects through the existing retention plan.

Transfer the final active-build reference to its idle cached connection until that connection
closes or hands ownership to its next request. Close the database before removing its final
record. Reclaim only owners proven dead or with a reused PID. Preserve foreign or ambiguous
owners; malformed published records refuse cleanup. No TTL establishes local completion.

An explicit selected HTTP or stdio server owns its retained build through startup, idle
intervals and serving until shutdown. Per-request handles use the same guarded selection
primitive. Activation remains independent of both lifetimes.

## Consequences

Readers and cleanup cannot acquire contradictory ownership. Source reads survive pruning,
and a later cleanup can reclaim drained older builds. Plans may retain a build beyond --keep
while a runtime owns it, and report that reason. Operational ownership writes do not edit
sources, activate builds or alter content identity. Atomic-write leftovers are not acquired
references. Remote requests require their own proven lifetime protocol; PID rules do not apply.
