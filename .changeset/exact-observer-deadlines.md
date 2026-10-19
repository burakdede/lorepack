---
'@lorepack/parsers': patch
'@lorepack/cli': patch
---

Check elapsed time before declaring a resident-memory observer deadline expired.

Retain bounded owner-loop context on Windows observer deadline failures without changing the reader command or timing guards. This adds observation overhead and does not identify the cause of a reader stall.
