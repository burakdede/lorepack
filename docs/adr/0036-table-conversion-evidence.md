# Record table conversion evidence in immutable builds

## Status

Accepted, 2026-10-16. Implements #430.

## Context

A numeric workbook sample cannot reveal that its value came from a formula cache.
The retained expression list is capped at1,000 and cannot prove a later column has no
formulas. Older immutable builds did not record complete column evidence. Local and D1
already retain table metadata; another row scan or query would duplicate compilation work.

## Decision

CSV/XLSX parser0.1.1 stores version1 `tableEvidence` with complete sorted formula-column
ordinals and actual scoped conversion warnings. CSV formula-looking text stays literal.
Keep the expression cap and imported cached values unchanged. Track formula-element presence
independently of expression text, including shared followers and absent cached values. Preserve
null-valued formula rows as data. Do not evaluate workbooks.

A shared pure reader exposes per-column `present`, `absent` or `unknown` markers. Missing
historical evidence yields `unknown` and `conversionWarnings: null`; newly recorded empty
warnings yield `[]`. Invalid supported metadata is refused as corrupt. Both adapters read
metadata in their existing resolution queries, with no extra round trip or row scan.
HTTP, MCP, SDK, CLI inspection and Studio carry the same description contract.

## Consequences

Parser versions invalidate older cached parses, and new builds have changed identities.
Historical builds remain readable without invented negative evidence. A presence marker
applies to the imported column, not every row or a freshness judgement about its cache.
Clients must distinguish unrecorded warnings from a recorded empty list.
