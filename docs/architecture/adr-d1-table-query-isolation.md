# ADR: Isolate remote table queries from the catalog database

## Status

Accepted

## Context

The Cloudflare Worker currently stores catalog metadata, active-build state, runtime bearer-token
hashes, search data, and projected table data in one D1 database. The statement guard limits a
model-authored table query to one projected table, but D1 does not provide the engine-level
authorizer available to the local SQLite backend. A defect in the guard could therefore expose
catalog data or runtime-token hashes.

The v0.1 contract includes typed CSV and XLSX tables, so removing remote table queries is a larger
compatibility regression than changing their storage boundary.

## Decision

Cloudflare deployments use two statically configured D1 bindings:

- `CATALOG_DB` stores the active pointer, projected build metadata, source and search data, and
  runtime-token hashes.
- `TABLES_DB` stores projected physical table data and its unavoidable SQLite system objects.

The Worker resolves table metadata through `CATALOG_DB`. `describeTable` samples and
model-authored table SQL execute only through `TABLES_DB`. The shared statement guard remains
required because `TABLES_DB` can contain tables for more than one immutable build.

New deployments must provide both bindings. A legacy receipt that names only one D1 database is
rejected with an actionable migration message rather than silently preserving the old boundary.

Projection and retention treat the two D1 databases as separate resources. A candidate is not
eligible for activation until its catalog metadata and table data have both been projected and
verified. Resume state records these steps independently so a failure never changes the active
pointer or requires rebuilding completed work.

## Consequences

- Runtime tokens and catalog tables are unreachable from the D1 connection used for model-authored
  SQL.
- Cloudflare target setup creates and validates one additional D1 database.
- Deploy receipts, target resolution, cleanup, retention, fixtures, and credentialed acceptance
  must carry both database names and IDs where Cloudflare exposes them.
- Existing single-D1 targets require an explicit target migration before table queries can be
  served again.
- The statement guard remains a correctness and cross-build isolation control, not the sole secret
  boundary.
