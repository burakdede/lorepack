---
"@lorepack/core": patch
"@lorepack/compiler": patch
"@lorepack/backend-local": patch
"@lorepack/cli": patch
---

Normalize path patterns and effective rule inputs with NFC, preserve valid dot-dot
names, refuse normalization collisions and report ignored or unsupported special
entries. New builds use normalization policy 2; verified readers retain policy 1.
