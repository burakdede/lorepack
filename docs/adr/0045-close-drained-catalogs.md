# Close drained local catalog connections

## Status

Accepted.

## Context

The provider cached the active catalog after its last reader finished. An activation in
another process could leave that catalog idle until the next request. Its reader record
correctly prevented unsafe deletion, but also prevented reclaiming the old build while the
server remained idle. The earlier request-boundary sweep did not satisfy #566's remaining
prune-before-another-request requirement.

An asynchronous watcher or timer would introduce a period in which prune still observes
the idle pin. Closing the connection while dropping only its pin would expose an open
Windows file to cleanup. Keeping the resource and its ownership lifetime aligned avoids
both states.

## Decision

Share a catalog only while at least one handle owns it. On the final release, close the
SQLite connection before removing its reader record, regardless of which build is active.
Do not add an activation watcher, timer or cache-retention option. Keep concurrent and
explicitly selected long-lived handles protected, and keep provider shutdown idempotent.

The pinned [Node 24.21.0 implementation](https://github.com/nodejs/node/blob/v24.21.0/src/node_sqlite.cc#L1356)
finalizes tracked statements before closing the connection. A regression keeps a prepared
statement alive and checks that it cannot be used after the final handle release.

## Consequences

Sequential requests reopen a read-only connection and repeat the schema check. The
unchanged 400-document/60-iteration benchmark remains below the existing target values in
the local before/after comparison, recorded in the
[verification report](../testing/idle_catalog_cleanup.md#retrieval-cost). This is provisional
measurement, not reference-hardware release qualification.

The ordinary HTTP/MCP server can stay running while another process activates and prunes
an older build, without a request, timer or shutdown releasing an obsolete idle reference.
In-flight readers and explicit retained servers still own their catalog until release.
