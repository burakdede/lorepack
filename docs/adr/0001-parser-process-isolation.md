# Isolate built-in parsers in a child process

## Status

Accepted.

## Context

Valid documents can block a synchronous parser or exhaust its JavaScript heap. In-process
parsing prevents timely cancellation and can abort the build process before it records a
typed result. Worker-thread probes recorded in
[PR #660](https://github.com/burakdede/lorepack/pull/660) also aborted the parent despite
resource limits with hostile CSV and PDF fixtures. Those results supersede the earlier
assumption in issue #594 that worker heap exhaustion always stays in the worker. Activation
must remain unchanged when parsing is interrupted.

## Decision

Run built-in parsers in one reusable Node child process per build. Bound each parse with a
wall-clock deadline and the child's V8 old-generation heap limit. Kill and replace the child
after a timeout, cancellation or crash. Record resource exclusions as typed per-file warnings
and preserve parser error codes across IPC.

The child runs with Node's permission model: filesystem reads are allowed, but writes,
subprocesses, workers and native add-ons are not. The privacy proof monitors network use in
the parent and child. Operational limits stay outside canonical configuration; the resulting
content and exclusions determine build identity.

## Consequences

The parent can respond to cancellation while a parser is blocked, and a V8 heap abort affects
the child. Reuse limits startup overhead to one child per build unless it must be replaced.
Inputs and results are copied through IPC, and the shipped CLI must include `parse-child.js`.

The heap limit does not cap total resident memory or decompressed buffers. That remains an
acceptance gap in [issue #594](https://github.com/burakdede/lorepack/issues/594); the deadline
is the available bound for those cases. [Issue #599](https://github.com/burakdede/lorepack/issues/599)
covers extracted-text amplification, which does not bound decompression memory. Parsers
supplied only by an embedder run in-process because the child resolves built-ins from its
own registry.

An attempt that retains existing canonical content reuses the immutable build and its
historical warnings. New exclusions from that attempt appear only in progress output until
[issue #662](https://github.com/burakdede/lorepack/issues/662) defines persistent attempt
diagnostics. Existing manifests must not be rewritten to attach those warnings.
