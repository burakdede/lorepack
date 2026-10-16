# Discover tables as located schema references

## Status

Accepted, 2026-10-16. Issue #429.

## Context

Task context indexed typed-table descriptions but returned an empty table slot. Descriptions
also contained samples, so delivering them as native prose flattened row values. A model
could not reliably discover and then query a typed table in the selected immutable build.

## Decision

Use existing filtered lexical candidates to discover table descriptions, preserving source
and sheet identity. The catalog search port carries table references resolved from the
candidate's recorded native-node table IDs in that same query. D1 retains both project and
build correlations. Keep the public listing unchanged. Context replaces matched table
passages with located, labeled schema references pinned to the captured build.

Schema and row reads use the existing separate read-only methods. Do not enumerate table
samples, duplicate SQL filtering in runtime code, or add another ranking engine. Count the
complete references in every delivery format and report whole-reference budget omissions.
Advance execution packing and serialization policy identities for this changed representation.

## Consequences

Models discover schemas without row prose or an active-build race. Metadata uses the same
candidate bounds and visibility as other task evidence. Whole native document evidence is
unchanged. Context clients must consume the typed table slot and retain the schema reference's
build ID. No stored build format, content identity, dependency or mutation tool changes.

The first integration used an additional table-list query. The unchanged D1 query-budget
regressions proved six round trips against the documented maximum of five. Carry references
in the existing candidate query instead; preserve the original maximum and extend its
coverage to a real typed-table task, including all-term to any-term fallback.
