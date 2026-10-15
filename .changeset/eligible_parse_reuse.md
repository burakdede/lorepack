---
'@lorepack/cli': patch
---

Report rebuilt/reused artifacts from actual parser work and eligible cache reuse.
A cached parse whose normalized body is missing now counts as rebuilt when Lorepack
restores it from source. Preserve raw cache lookup statistics and table reparsing.
