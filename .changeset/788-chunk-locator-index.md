---
"@lorepack/compiler": patch
---

Index source nodes once per artifact when producing chunks, avoiding repeated scans while preserving chunk text, identifiers and source locators.
