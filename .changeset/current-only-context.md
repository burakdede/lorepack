---
'@lorepack/runtime': patch
'@lorepack/cli': patch
'@lorepack/deploy-cloudflare': patch
---

Keep default search and context current-only even when only historical candidates match.
Require explicit labeled historical expansion and support it through CLI export.
Deployment verification explicitly probes historical candidate content without relaxing
the default serving policy.
