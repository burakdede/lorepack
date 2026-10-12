---
'@lorepack/core': patch
'@lorepack/runtime': patch
'@lorepack/sdk': patch
'@lorepack/cli': patch
'@lorepack/deploy-cloudflare': patch
---

Identify table queries from their captured namespace, build, table, SQL and row
limit. Return stable query IDs with explicit table-level provenance across local
and remote runtimes, HTTP/SDK, MCP and Studio without inventing source-row lineage.
