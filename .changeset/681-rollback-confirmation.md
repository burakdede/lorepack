---
"@lorepack/cli": patch
---

Recheck Studio's rollback target and confirmation under the project lock. A request
that waited behind a different activation refuses its stale target without undoing
the competing pointer change.
