# Table query identity and provenance precision

## Status

Accepted, 2026-10-12. Implements the bounded v0.1 contract in #695.

## Context

A table locator identifies the source table, but cannot identify the SQL that
produced filtered, reordered or aggregate rows. Generated column names can be
translated back to declared source types; expressions and aliases retain SQLite
values. Neither operation establishes exact source-row or cell lineage.

## Decision

Every successful table query returns its captured `buildId`, requested `tableId`,
`queryId` and `provenancePrecision: "table"`. The existing `locator` applies to the
table as a whole, including aggregate results. It does not attribute individual
result rows or cells. Full row, aggregate and join lineage remains #433 after v0.1.

`queryId` is `query_` followed by a lowercase SHA-256 digest of the existing portable
canonical serialization. Its versioned domain is `lorepack-table-query-v1`. Inputs
are canonicalization version, captured corpus/namespace/build, requested table,
exact submitted SQL, resolved row limit, shared maximum rows/bytes and table-level
precision. Omitted limit and explicit100 are identical. Whitespace, SQL, limit,
table, namespace or build changes produce a different request identity. Freshness,
activation generation, timing and absolute paths are excluded.

The shared runtime computes identity while holding the same build handle used for
the query. Storage adapters perform no new lookup or write. HTTP/SDK, MCP text and
structured content, Studio and remote projections receive the same contract.

## Consequences

Clients can associate typed results with the exact captured query request and
replay it against a retained build. The ID does not store SQL, create a persistent
receipt, prove source truth or guarantee identical execution across database
versions. Callers must retain their request if they need replay. No build content,
sealed package identity, SQL isolation or existing query limit changes.
