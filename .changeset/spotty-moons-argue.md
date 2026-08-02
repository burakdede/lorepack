---
'@lorepack/core': minor
---

Add `LORE_E_SOURCE_UNREADABLE` (exit 1) for a source file that exists and cannot be opened.
It used to surface as `LORE_E_INTERNAL` with a raw errno, which told the user to report a
bug for a permission they could fix. Error codes are part of the public contract, so the
addition is recorded here.

The fallback `next:` line no longer names `lore doctor`, which does not exist until Phase 3.
