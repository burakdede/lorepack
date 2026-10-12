---
'@lorepack/core': patch
'@lorepack/runtime': patch
'@lorepack/mcp': patch
'@lorepack/sdk': patch
'@lorepack/cli': patch
'@lorepack/deploy-cloudflare': patch
---

Add bounded detached context receipts across CLI, HTTP, MCP, SDK and Studio.
Verify exact saved payload bytes and captured execution identity. Default requests
create no receipt or history; request capture needs explicit opt-in. Include
receipt metadata in complete output budgeting and expose the strict versioned contract.
