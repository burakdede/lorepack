# Preserve JSONC bytes with property-bound ownership

## Status

Accepted, 2026-10-16. Implements #581 and its consolidated #667 fixtures.
Supersedes the JSONC edit mechanics in [the original merge ADR](../architecture/adr-toml-merge.md).

## Context

Formatted jsonc-parser edits preserve values but reformat inline neighbours and empty server
objects. Twenty-two new unit/actual CLI regressions failed byte comparisons while semantic
checks and twenty-eight existing controls passed. Raw edits preserve bytes, but ownership
comments above a shared physical line could then be attributed to an unrelated property.

## Decision

Use the existing parser's raw edits for the managed value and retain re-parse/semantic checks
before any write. Prepend new properties before existing object trivia so trailing comments
and foreign subtrees stay intact while connected. Put ownership comments at the managed key
boundary. On removal, use the parser AST and scanner to delete only the managed property,
its following comma and the inserted comment/newline. Preserve the original object trivia. Add a private `entryPath` array to new ownership comments. Locate and remove
only the matching comment pair, allowing several managed entries to share an inline line.
The human note names the path. Keep ASCII marker serialization and project-root ownership.

Public owner results remain `{projectRoot, createdAt}`. Existing property-local markers without
`entryPath` stay readable. Invalid or differently bound markers do not grant ownership.
No formatter, custom JSON lexer, dependency or snapshot of unrelated config values is added.

## Consequences

Connect/disconnect preserves the original fixture bytes, including BOM and CRLF. Unrelated
edits between those operations survive. JSONC remains valid for VS Code's schema because
ownership is a comment, not an extra server key. Created configuration containers retain their
existing lifecycle and remain empty after removal of the server entry. Client trust dialogs
and Windows descendant cleanup remain separate qualification obligations.
