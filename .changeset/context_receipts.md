---
'@lorepack/core': patch
'@lorepack/runtime': patch
'@lorepack/mcp': patch
'@lorepack/sdk': patch
'@lorepack/cli': patch
---

Add bounded detached HTTP/MCP context receipts and portable verification of
the exact saved payload bytes. Default requests create no receipt or history;
request capture needs explicit opt-in. Include receipt metadata in complete
output budgeting and expose the strict versioned public contract.
