# Preserve worker contexts in inherited counter streams

## Status

Accepted, 2026-10-14. Issue #700. Supplements ADR0019.

## Context

An inherited-worker fixture writes three collector identities to one descriptor.
Each identity starts its own sequence at one. Process-only replay rejects a valid
parent and two workers. Treating their events as one counter map would also lose
independent zero baselines and lifecycle evidence.

## Decision

Name worker frames explicitly and validate each collector independently. Observe
Worker creation through a constructor proxy that forwards unchanged arguments and
returns the actual Worker. Observe actual exit and explicit termination while
preserving caller promises, options, streams and event listeners. Bind each worker
to its parent's creation and closure receipts and the real process close. A manual
exit event with a live thread does not qualify closure.

Require exact source hashes, compatible layouts, contiguous per-context sequences
and genuine increments. Require natural completion to match actual worker exit.
Keep explicitly terminated workers interrupted when JavaScript completion is absent.
Reject orphaned threads, missing receipts and frames after observed worker closure.
Merge validated maps with checked integer sums and retain independent thread maps
and lifecycle metadata. Never drop empty workers or fabricate completion.

## Consequences

The complete campaign measures inherited workers without changing their execution
contract. Worker contexts that do not inherit a collector remain unqualified rather
than silently disappearing. Existing failed campaign folders remain invalid. Native
Windows CI and a fresh full campaign are still required before claiming qualification.

Reference: [Node24 Worker lifecycle and constructor options](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html).
