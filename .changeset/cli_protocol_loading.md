---
'@lorepack/cli': patch
'@lorepack/connect-clients': patch
'@lorepack/deploy-cloudflare': patch
---

Load protocol adapters when their handlers run and keep deployment client imports
separate from Worker adapters. Preserve lazy loading in the packaged CLI through
shared ESM chunks, reducing ordinary archive verification startup memory without
changing resource limits or runtime flags.
