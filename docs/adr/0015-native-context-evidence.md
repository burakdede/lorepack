# Preserve native evidence in task context

## Status

Accepted, 2026-10-12. Issue #698.

## Context

Lexical chunks can split a paragraph or table. Selecting a permission from its first
chunk can omit an attached qualification or negation in the same native unit. The
immutable catalog already records the canonical nodes referenced by each chunk.

## Decision

Task context resolves every candidate to its ordered canonical native nodes, with
its recorded heading path. Resolution occurs in the existing bounded lexical query,
against the captured build. Ordinary search remains an excerpt-oriented operation.

A native body is admitted only if every referenced node belongs to the same artifact
and captured build and has text, and the joined UTF-8 body is at most 65,536 bytes.
The cap includes separators. Missing or oversized bodies produce a `structural-unit`
omission, with native node IDs when available. Complete output budgeting may omit a
whole resolved unit for budget; it never shortens that unit to keep its permission.

The execution policy identifies native-unit packing and its byte cap. Context items
identify their native nodes as complete; omissions identify those nodes as omitted.
Stored compiler chunk estimates remain provenance, separately from delivered-output
accounting. Canonical content, build identity and stored schema are unchanged.

## Consequences

Attached conditions inside a native paragraph, code block, list or table travel with
the selected evidence. Large native units can be omitted even when their retrieval
fragment is small. Resolution adds work within the existing queries and introduces
no per-candidate storage calls, model or dependency.

Completeness means the recorded native unit, not an entire document or every related
document. Separate paragraphs and cross-document qualifications are not inferred.
Parser normalization still applies, and headings are the recorded ancestor labels.

Native regression cases are defined in
[the real CLI checks](../../packages/cli/test/native_evidence_closure.test.ts).
