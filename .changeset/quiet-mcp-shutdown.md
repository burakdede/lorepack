---
"@lorepack/cli": patch
---

Close MCP stdio transport on termination signals without requiring stdin EOF, releasing build handles once and removing shutdown listeners.
