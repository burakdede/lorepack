# Run watched rebuilds off the serving event loop

## Status

Accepted.

## Context

`lorepack dev` promises to serve the active immutable build while compiling its
replacement. SQLite catalog operations and durable filesystem writes are synchronous.
Running them on the HTTP event loop can prevent Node from accepting an already-sent
request before an idle keep-alive timer expires. A controlled stalled report write
reproduces `ECONNRESET` in the actual dev binary; increasing timeouts would retain the
shared event-loop bottleneck. See [verification](../testing/watch_read_stability.md).

## Decision

Run each watched rebuild in a built-in Node worker. Keep the initial build before
server startup. Use the existing `runBuild` pipeline and validated configuration
snapshot, forward progress and cancellation, and reconstruct `LoreError` metadata
alongside Node's cloned error/cause. Await worker exit before settling the rebuild.
The worker closes its parent port after build cleanup. The watcher still serializes
rebuilds and only the existing activation pointer changes which build is served.

Ship the compiled worker beside the CLI entries. Source-based tests locate that same
compiled worker, following the existing SQL child-process layout. Inherit Node options
and environment rather than replacing them. Do not change HTTP timeout or keep-alive
settings. [Node's worker contract](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)
defines option inheritance, structured cloning and worker lifecycle.

## Consequences

HTTP, MCP and Studio keep their event loop during synchronous candidate compilation.
The worker adds startup and a separate JavaScript heap per serialized rebuild; it is
not a sandbox or a guarantee against process-wide memory exhaustion or native crashes.
Parser subprocess limits, build identity, immutable storage, validation and lock
ownership remain in the existing compiler. Cancellation remains cooperative at its
checkpoints. No new dependency or installation step is required.

The controlled regression establishes the event-loop failure mechanism. It does not
identify which original Windows filesystem operation stalled. The original unchanged
source-churn workload and native qualification remain required before closing #778.
