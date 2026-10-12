# Remote read ownership during retention

## Status

Accepted, 2026-10-12. Part of #439 and audit F09.

## Context

Workers HTTP requests have no fixed wall-time bound. A lease timeout alone cannot prove
that a paused reader finished. Remote cleanup previously removed normalized A bodies while
200 captured reads still owned A. A reader may also register after a cleanup preview.

## Decision

Register a unique operational owner through one conditional primary D1 INSERT RETURNING.
Capture the selected tuple and current generation in that statement. Reject missing,
foreign or deletion-claimed evidence before acquiring it. D1 primary writes serialize
registration against conditional deletion claims; replica observations cannot grant ownership.

Bound one remote read to 300 seconds of primary database time. Fully materialize its DTO,
then await one DELETE RETURNING that checks the owner's original expiry and releases it.
Refuse an expired or missing owner with an explicit limit error, including when payload
materialization already completed. A timeout is therefore a serving contract, not evidence
that the reader stopped. Local native process ownership remains unbounded.

Reconcile each cleanup preview against current ownership and immutable object references.
Atomically claim only inactive, unowned builds. Activation uses a conditional pointer change
that checks the previous generation and refuses claimed builds. SQL RETURNING observes
pre-deletion column values for the terminal expiry check. Operational records never affect
content identity, source files or model-facing mutation capabilities.

Candidate apply, verification and cleanup acquire a separate database-wide exclusive
mutation capability. It has no automatic expiry: a pending physical DDL or R2 delete can
outlive a client, and final read refusal cannot undo that mutation. Preserve ambiguous
interrupted owners. Confirmed operations release after awaited work finishes; an unconfirmed
Wrangler write keeps its capability and is not replayed automatically. Manual recovery must
first stop the old operation and establish remote completion, then remove only its exact token.

Reuse verified projections rather than rebuilding active or acquired indexes. Refuse a stale
candidate resume whose metadata disappeared. Resumed cleanup rechecks all current archive
and object references and clears deletion claims only after all stages finish.

## Consequences

A still-owned request survives activation and cleanup; deletion-claimed evidence cannot
acquire a new reader or become active. Crashed read ownership eventually stops retaining
evidence, and a late operation fails before returning success. The final response may report
an expiry even if all object bytes were read successfully. This deadline does not bound
response network delivery or keep a persistent receipt alive.

Mutations sharing a catalog serialize while runtime reads continue. Ambiguous interrupted
writers may block further deployment and cleanup until explicit operator recovery. Elapsed
time never proves a writer finished. This operational availability trade-off prevents
reclamation underneath a writer whose completion cannot be established.

Primary references: [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[Worker limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 replication](https://developers.cloudflare.com/d1/best-practices/read-replication/),
[SQLite RETURNING](https://www.sqlite.org/lang_returning.html).
