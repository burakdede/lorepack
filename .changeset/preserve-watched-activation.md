---
"@lorepack/cli": patch
---

Preserve explicitly selected builds when watcher events leave source inputs unchanged.
Continue rebuilding actual edits and retrying failed builds without an extra hashing pass.
