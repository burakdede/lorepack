---
"@lorepack/backend-local": patch
---

Close local catalog connections and release their cleanup references after the final reader finishes, allowing prune after external activation without another server request. Keep concurrent readers and explicitly selected servers protected until their handles release.
