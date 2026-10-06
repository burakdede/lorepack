---
'@lorepack/core': patch
'@lorepack/compiler': patch
---

Reject source roots that normalize to the same source ID or overlap, and report filesystem
entries that cannot be inspected as `unreadable` discovery warnings.
