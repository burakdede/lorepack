# Retain restricted process receipts within the project

## Status

Accepted, 2026-10-14. Issue #700. Supplements ADR0019.

## Context

The original boundary suite grants build processes write access only to their
project. Nested coverage receipts outside that grant fail before measurement can
qualify. Original monitor preloads can also stop a process before its owned CLI
entrypoint starts. Ignoring these launches would hide real execution.

## Decision

Keep all original grants, preloads, environment, limits and caller-visible
arguments. The host creates a private project namespace and tracks its filesystem
identity. Each actual child retains receipts under its own process ID. After
close, the parent validates ownership and copies only expected regular receipt
files exclusively into campaign custody before removing its own empty namespace.
Foreign paths and replacement directories reject collection.

Bind a CommonJS counter initializer to the emitted artifact receipt. Run it before
original ESM imports, removing only its own instrumentation arguments before they
execute. Transfer the initialized descriptor and counter namespace once to the
entrypoint bootstrap. Preserve ordinary duplicate-initialization rejection.
A preload that exits before owned code runs contributes actual lifecycle frames
and no owned source hits. Empty streams remain invalid.

## Consequences

Restricted measurement needs no additional write permission and survives fixture
cleanup. The emitted initializer is part of the authenticated measurement graph.
Focused regressions compare original and measured exit codes, output and grants.
A fresh complete campaign and native CI remain required for qualification.

Reference: [Node24 preload ordering](https://github.com/nodejs/node/blob/v24.21.0/doc/api/cli.md).
