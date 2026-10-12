# Detached context receipts

The HTTP and MCP context adapters can create a bounded receipt after assembling
and serializing the captured build's context. Request `receipt: true` for a
redacted receipt, or `receipt: {captureRequest: true}` to include the normalized
task and filters. The default creates no receipt or query history.

HTTP returns base64url-encoded JSON in `Lorepack-Context-Receipt`. Its
`payloadDigest` is SHA-256 of the exact UTF-8 response body, with no receipt
inside that body. MCP returns the receipt in
`result._meta["lorepack.dev/context-receipt"]`. Its named `mcp-content` payload
is `JSON.stringify({content: result.content, structuredContent:
result.structuredContent})`, preserving the emitted text block's whitespace.
JSON-RPC IDs, transport framing and SDK protocol metadata are outside that
content boundary. Both MCP content channels are covered.

Receipts identify the corpus, namespace, full build ID, resolved policy and
selection IDs, payload format, digest and byte count. `requestDigest` hashes
the canonical resolved selection and policy using the
`lorepack-context-request-v1` domain. `receiptId` hashes every receipt field
except itself using the `lorepack-context-receipt-v1` domain and existing
canonicalization version1. Reordering JSON keys does not change verification;
changing payload whitespace does.

The receipt states `boundary: lorepack-emitted-content` and
`assurance: integrity-only`. These hashes detect corruption of a retained
receipt/payload pair. They do not authenticate its author, prove source truth,
or prove what a downstream model received or used. Identifiers and hashes are
not access credentials or a confidentiality guarantee.

The detached JSON receipt is limited to4,096 UTF-8 bytes. Explicit request
capture that cannot fit fails with `LORE_E_LIMIT_EXCEEDED`; request text is never
silently truncated. Receipt-enabled execution reserves that bounded metadata
space within complete-output packing, including the whole MCP result. Its
serialization descriptor is version3 with the declared receipt reservation.
Ordinary requests retain serialization version2 and existing behavior.

Lorepack does not persist the payload or log the request: `payloadRetained`
is false. Save the original content bytes alongside the receipt. A digest
cannot reconstruct discarded text; requesting the same task later is not a
replay of those exact bytes. `requestRetained` is true only after explicit
request capture. Captured selection plus the recorded policy describes the
normalized request, rather than preserving cosmetic defaults or duplicate
filter syntax.

`createContextReceipt` and `verifyContextReceipt` are portable exports of
`@lorepack/core/worker`. Verification needs only the receipt and saved payload
bytes. It can succeed after a build expires, but does not make an expired
build available for a new read. New selected-build requests still fail
explicitly when their retained build is missing. Direct runtime callers
serialize their returned bundle and create the detached receipt at their own
content boundary.

The schema is [context-receipt.json](../../schemas/context-receipt.json).
CLI sidecar delivery, typed SDK receipt access and Studio inspection are the
remaining integration steps in #434; they are not advertised as implemented
by this initial contract change. Persistent recording remains separate #435.
