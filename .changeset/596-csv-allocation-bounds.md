---
"@lorepack/parsers": patch
---

Stop CSV imports at the first excess row or column before unbounded record allocation. Keep a typed warning and cited file description without importing prefix rows, and invalidate older CSV parse caches.
