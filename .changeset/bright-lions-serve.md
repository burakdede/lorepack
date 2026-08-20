---
'@lorepack/mcp': patch
'@lorepack/runtime': patch
---

Declare the runtime `zod` imports in each published package that uses them, and add an
architecture test that fails when compiled JavaScript imports a package missing from that
package's published dependency manifest.
