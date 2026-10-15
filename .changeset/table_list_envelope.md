---
'@lorepack/cli': patch
'@lorepack/sdk': patch
---

Return the captured build identity and source freshness with table listings across
runtime, HTTP, MCP tools/resources and SDK, including empty listings. Internal
LoreRuntime consumers now read result.tables; HTTP and MCP retain their tables field.
