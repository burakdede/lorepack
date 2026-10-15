# Publish complete initial state without replacement

## Status

Accepted.

## Context

Concurrent first opens currently expose `state.sqlite` before its schema and runtime
identity are complete. A controlled initializer paused with an exclusive SQLite lock
causes five cold peers to exhaust the existing five-second timeout in the schema probe.
Existing state must retain its migration, checksum and newer-schema refusal contracts.

## Decision

Initialize a private database under `.lore/tmp/state-init-*`, apply the existing migrations
and validate its runtime identity. Close SQLite before publishing the completed file with
[`linkSync`](https://nodejs.org/download/release/v24.21.0/docs/api/fs.html#fslinksyncexistingpath-newpath).
The operation refuses an existing destination, so a competing initializer cannot replace
the winner. Sync the parent directory and remove the private name before this initializer
opens only the canonical `.lore/state.sqlite` path. Every opener validates that winner
through the existing read-only schema guard before writing.

No connection uses a private name after publication. SQLite's
[file-alias rules](https://www.sqlite.org/howtocorrupt.html) prohibit concurrent use through
different names because their journals differ. Existing operational databases are never
renamed, copied or replaced. Their five-second busy timeout remains unchanged.

## Consequences

Concurrent initializers return the same winning runtime identity without waiting for an
unpublished initializer. Migration rollback and checksum verification remain unchanged.
Publication requires filesystem hard-link support. Unsupported publication fails rather
than using a non-atomic copy or replacing existing state.

Normal failures remove their private directory. A killed initializer can leave an inert
`state-init-*` directory. It is deliberately distinct from `candidate-*`: a build holding
the project lock must not sweep another process's live state initialization. Private names
never become serving databases, source inputs or build identity.
