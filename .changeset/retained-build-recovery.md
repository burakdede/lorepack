---
"@lorepack/cli": patch
---

Keep retained builds usable after the source directory and parser cache are removed.
Rollback, activation, inspection, search, export, default packing, and read-only HTTP
or retained MCP serving no longer require live sources. Queries report unknown
freshness when sources cannot be checked. Activation and rollback reject invalid or
mismatched manifests before changing the active build.
