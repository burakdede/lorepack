---
'@lorepack/cli': patch
'@lorepack/sdk': patch
---

Expose persistent corpus and runtime namespace IDs in runtime result envelopes,
separately from content hashes and display names. Refuse foreign, forged,
released or closed local handles. Cloudflare deployments retain the corpus ID,
use a distinct namespace and validate their project binding before serving.
