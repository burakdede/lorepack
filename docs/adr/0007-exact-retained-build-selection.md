# Exact retained-build selection

## Status

Accepted, 2026-10-12. Implements #432 and audit #688 finding F02.

## Context

A review or model session must keep reading build A while another process activates B.
An active handle captures one call, but cannot select the same build on subsequent calls.
Corpus and namespace identify the serving boundary; a build digest alone grants no access.

## Decision

Add optional exact full-build selection at provider acquisition and all seven read
capabilities. Every selected call acquires an owned handle and fails if that build is not
retained and readable. No adapter may substitute the active version. Remote acquisition
requires the configured project's verified projection. Existing unselected capture stays.

HTTP and MCP carry stateless selection. CLI servers can configure one immutable default
and reject overrides. SDK clients verify response build IDs, so an older server that ignores
selection cannot silently answer. Selection does not create a persistent task registry or
protect a retained version from pruning.

## Consequences

Sessions can reproduce retained content without rebuilding or activating it. A pruned or
unavailable selection fails explicitly. Retention protection is tracked separately in #439.
Freshness is unknown for a selection different from active: checks of current sources against
the active build cannot establish freshness for an older retained version.
