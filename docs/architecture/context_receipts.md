# Detached context receipts

The CLI, HTTP and MCP context adapters can create a bounded receipt after assembling
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

For a CLI export, pass `--receipt context.receipt.json`. The sidecar identifies
stdout, including its final newline, or the exact `--output` file bytes when
that option is present. With `--output`, JSON acknowledgement stdout is a
separate response and is not the receipted file. `--capture-request` explicitly
includes the normalized selection and requires `--receipt`. The sidecar is
compact JSON within the same4,096-byte ceiling.

```bash
lorepack export --task "rollback" --format json --output context.json --receipt context.receipt.json
```

Existing files require `--force`; output and receipt paths must differ. Files
are written atomically individually, not as a transaction across two paths.
After an I/O failure, check which files were written before retrying. For
stdout, the receipt identifies the stream submitted by the CLI, not an
acknowledgement from a downstream reader. Choose export paths outside your
configured source roots if they should not become later build inputs.

`createContextReceipt` and `verifyContextReceipt` are portable exports of
`@lorepack/core/worker`. Verification needs only the receipt and saved payload
bytes. It can succeed after a build expires, but does not make an expired
build available for a new read. New selected-build requests still fail
explicitly when their retained build is missing. Direct runtime callers
serialize their returned bundle and create the detached receipt at their own
content boundary.

The schema is [context-receipt.json](../../schemas/context-receipt.json).
Persistent recording remains separate #435.

### SDK retention

`LoreClient.contextForTaskWithReceipt(request, signal)` returns the parsed bundle, detached
receipt and original HTTP payload text. The client recomputes version1 receipt, payload,
policy, selection and request digests before returning. It rejects missing headers, unknown
receipt fields or versions, mismatched capture and changed bytes with `LORE_E_SCHEMA_MISMATCH`.
Authentication, timeout, cancellation and no POST retry use the normal client pipeline.
The SDK keeps zero runtime dependencies and uses platform Web Crypto. Retain `payload`
unchanged for verification; serializing the parsed bundle again is not byte preservation.

### Studio retention

In Playground, select **Keep a receipt** before assembling. **Include task and filters in
receipt** is a separate explicit choice. The receipt section reports the captured full
build, policy and payload digest after SDK integrity verification. **Save exact context**
and **Save receipt** download that result without issuing another context request; editing
the form does not change either download. Both files are required for later verification.
The separate **Copy as export** action creates a Markdown export and is not covered by this
JSON context receipt. CLI equivalents save a JSON/receipt pair; HTTP equivalents save the
JSON body and response headers containing the base64url receipt.

See the [Studio verification checklist](../testing/context_receipts.md).

For an explicitly allowed Cloudflare browser origin, receipt-bearing responses expose
`Lorepack-Context-Receipt` through CORS so the SDK can verify it. Disallowed origins still
fail before retrieval; receipt opt-in does not widen the allowlist or authorization.
