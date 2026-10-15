---
"@lorepack/cli": patch
---

Record actual activation transitions and select bare rollback from the previous active
build across local lifecycle, Studio and Cloudflare deployment paths. Refuse unknown or
pruned predecessors instead of choosing newer never-active candidates.
