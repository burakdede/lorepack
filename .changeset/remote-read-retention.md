---
'@lorepack/cli': patch
'@lorepack/core': patch
'@lorepack/runtime': patch
'@lorepack/deploy-cloudflare': patch
---

Await remote read ownership release, preserve acquired builds during cleanup, and refuse
expired remote operations explicitly. Fence reader registration and activation against
conditional deletion claims while preserving the existing D1 query maxima.

Coordinate candidate apply/verification with cleanup, reuse verified indexes, recheck resumed
object references, and preserve ambiguous mutating owners until explicit recovery.
