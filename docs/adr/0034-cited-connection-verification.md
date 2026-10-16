# Verify a build and cited source when connecting

## Status

Accepted.

## Context

A responsive MCP tool list does not identify the intended immutable build or establish that
it contains readable context. The configured server cannot supply its own expected identity.
The existing startup command may build before serving, so reading the host expectation before
startup would incorrectly compare against the previous build.

## Decision

The CLI host supplies a lazy expectation reader to every connector and verified snippet.
After startup and the existing protocol/tool checks, it reads the intended active immutable
build through the local runtime, paging the pinned source inventory until a readable source
is found. Use the existing bounded source read and its explicit truncation.

The shared verifier calls `lore_build_info` and a build-pinned `lore_read_source`. Validate
both structured results with the existing schemas and compare build ID, citation, text and
truncation with the independent expectation. Success reports only build ID and citation.
Wrong builds, missing readable content and failed reads return actionable failures; verified
snippets propagate these failures through the CLI exit code. Client trust stays separate.

## Consequences

Database access remains in the host/backend adapter. Connectors receive an explicit callback
and preserve the existing protocol negotiation, timeouts and child cleanup. Config formats,
ownership and trust rules remain adapter responsibilities. Matching canonical builds can
have the same ID at different absolute paths; verification establishes content identity and
provenance, not physical directory identity. It does not prove an external client's trust
prompt was accepted.
