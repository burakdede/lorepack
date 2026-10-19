# Keep campaign and fixture counters independent

## Status

Accepted, 2026-10-13. Issue #700.

## Context

The coverage campaign runs the ordinary instrumentation regression fixtures.
Those fixtures install their own native collectors in child processes. A
single global counter object prevents the campaign collector and fixture
collector from running together. Skipping the fixtures would weaken the gate.

## Decision

Use two fixed counter namespaces: the existing native fixture namespace and
a separate campaign namespace. Pass the campaign namespace through native
preparation, compiled-source validation, CLI bundling and generated import
preloads. Preparations record it, and readers reject a namespace mismatch.
Neither caller can supply an arbitrary namespace. Each collector keeps its
own duplicate-registration guard and exit finalization.

Keep source identities, counter locations, hashing and reconciliation
unchanged. The namespace selects counter storage, not ownership or hits.

## Consequences

A real child-process regression runs both collectors over the same source
identity with different execution counts. Independent reconciliation retains
three campaign calls, two fixture calls and zero calls to the unused function.
The split CLI and generated worker fixture use the campaign namespace too.

This decision does not qualify the complete campaign. Preserving explicit
fixture descriptors, remaining Node launch forms and all owned script
execution are still required before the release coverage gate can close.
