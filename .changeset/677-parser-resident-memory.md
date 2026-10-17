---
"@lorepack/parsers": patch
"@lorepack/cli": patch
---

Observe built-in parser resident memory outside parser code and stop an observed threshold breach with a located `parse-memory` warning. Configure the sampled threshold with `LORE_PARSE_RSS_MB`; sampling may overshoot and does not provide a hard memory quota.
