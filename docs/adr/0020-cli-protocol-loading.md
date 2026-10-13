# Load CLI protocol adapters when used

## Status

Accepted, 2026-10-13. Issue #722.

## Context

Archive verification shares CLI startup with serving and deployment commands.
The Cloudflare package root also exports Worker handlers. Those imports and the
single-file bundle evaluate protocol schemas for ordinary local commands, leaving
insufficient margin for streamed verification under the existing RSS gate.

The unchanged 512MiB regression exceeded the 256MiB ceiling. Smaller stream buffers
did not address startup allocation; very small inflate output substantially slowed
verification. Removing the gate would conceal the resource failure.

## Decision

Use the deployment client entrypoint for CLI control operations and retain the
existing Worker/root exports. Load protocol SDKs inside MCP/HTTP startup and client
verification. Keep public MCP factories synchronous.

Build the five CLI/child entrypoints together as standard ESM with shared chunks
so dynamic imports remain lazy in the shipped product. Keep chunks beside the
entrypoints because child and migration lookup depend on that directory. Package
the complete output and audit external dependencies in every generated chunk.

## Consequences

Ordinary CLI commands avoid unrelated Worker/protocol initialization. Actual loader
regressions reject SDK resolution during help while preserving its serving commands.
Protocol operations and teardown remain separately tested.

The [focused RSS evidence](../compatibility/archive_rss_2026_10_13.json) retains the
original ceiling and records actual artifact hashes. Full verification and native
three-platform qualification remain necessary. Native coverage bootstraps must
initialize collection before shared chunks execute; entry banners alone no longer
establish that ordering.
