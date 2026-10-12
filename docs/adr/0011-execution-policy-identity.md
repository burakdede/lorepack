# Separate context execution from content identity

## Status

Accepted for implementation, 2026-10-12. Issue #693, audit F04.

## Context

Ranking and packing can change without recompiling evidence. A content build ID cannot
identify the policy or resolved request that selected context. Node-only hashing also
cannot cross the existing portable runtime boundary.

## Decision

Publish a version1 execution descriptor on context bundles. Hash resolved policy and then
build-scoped request under separate canonical domain tags. Reuse the existing length-prefixed
canonical serializer through Worker-safe Web Crypto. Keep content inputs and IDs unchanged.
Include actual ranking weights, packing constants and explicit algorithm versions so
changed execution behavior is attributable. Normalize effective filters, not observation state.

Retain compiler/version provenance for stored chunk estimates. Identify the context DTO
serialization; Markdown carries its IDs. Exact emitted-byte receipts remain #434. Do not
add a durable task registry, model-call capture or automatic conflict inference.

## Consequences

CLI, SDK, HTTP, MCP and projected D1 can describe the same policy. Namespace/corpus bindings
remain selection inputs; digests are not access grants. Version/weight changes require
updated identities and fixtures. This metadata does not retain evidence or guarantee a
model answer. Historical payloads without descriptors have no execution identity to report.

Visibility version2 records the current-only default adopted in #699. Historical expansion
is explicit and changes the resolved policy digest. The identity does not change content
build IDs or decide whether a document is true.
