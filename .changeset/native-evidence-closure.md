---
'@lorepack/core': patch
'@lorepack/runtime': patch
'@lorepack/backend-local': patch
'@lorepack/deploy-cloudflare': patch
'@lorepack/sdk': patch
'@lorepack/cli': patch
---

Preserve complete native units in task context so attached qualifications and
negations cannot disappear at a retrieval chunk boundary. Report unsupported or
oversized closure explicitly, without reading source files or inferring truth.
