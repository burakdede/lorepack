# Separate operational identity from content

## Status

Accepted.

## Context

Equivalent content can produce the same build digest in two projects. A display name
can change. Neither value establishes which collection or runtime owns a request.
Local handles previously selected a database using only the digest, so a foreign or
released handle could access a cached connection (#697).

## Decision

Persist one corpus ID and one local namespace ID in mutable `state.sqlite`, seeded
once by a versioned migration. Keep them outside canonical content and manifests.
Require valid records rather than regenerating identity during reads. Preserve the
pair with retained state; a fresh state database represents a new binding.

Bind handles to their issuing provider and connection using object ownership, in
addition to carrying identity metadata. Metadata and content digests do not grant
access. Refuse foreign, forged, released and closed handles before catalog reads.

The local owner controls filesystem access. These IDs do not introduce tenants or
replace remote token authentication. Destination runtimes must establish their own
binding rather than accepting archived identity as an authorization grant.

## Consequences

Renames preserve corpus identity and equivalent builds remain portable and content
addressed. State backups must preserve identity alongside activation history. Losing
the state means losing the original local identity; it cannot be inferred from the
build. Cross-process build retention remains a separate lifecycle concern (#439).
