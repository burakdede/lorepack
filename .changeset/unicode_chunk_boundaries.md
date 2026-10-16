---
'@lorepack/compiler': patch
'@lorepack/cli': patch
---

Preserve Unicode surrogate pairs when splitting oversized text and apply configured
bounded overlap. Include the chunker algorithm version in parse-cache identity so
unchanged sources cannot reuse chunks produced by the old algorithm.
