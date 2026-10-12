# Detached receipts identify emitted context

## Status

Accepted, 2026-10-12. Issue #434, CORE-34/F03.

## Context

An immutable build identifies source-derived content, but runtime policy and
serialization affect what Lorepack emits. A receipt embedded in the payload
it hashes is circular. Logging every private task would also change the
privacy boundary without a caller's explicit capture choice.

## Decision

Emit bounded opt-in detached receipts at each serialization adapter. Hash
exact payload bytes and separately identify the canonical receipt, captured
build and execution policy. Keep request text redacted unless explicitly
captured. Preserve actual-byte verification independently of the runtime or
source workspace. HTTP uses a header; MCP uses result metadata and names its
two-channel content boundary. Reserve receipt metadata in complete-output
packing rather than assuming every host hides it from a model.

## Consequences

Callers retain the receipt and exact content bytes themselves. Default reads
create no history. A receipt verifies integrity, not authorship or model use.
Expired builds remain unavailable for new reads even when a retained pair
still verifies. Persistent recording, final model-input capture, case chains
and attestations remain separate work.
