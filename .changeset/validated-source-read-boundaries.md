---
"@lorepack/compiler": patch
"@lorepack/cli": patch
---

Validate source identity, regular-file type and byte limits through one handle per read pass. Refuse uncertain build candidates while retaining the active build.
