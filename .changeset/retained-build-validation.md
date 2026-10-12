---
'@lorepack/core': patch
'@lorepack/compiler': patch
'@lorepack/backend-local': patch
'@lorepack/cli': patch
---

Verify an exact retained build without compiling changed or unavailable sources.
Reuse bounded read-only catalog checks and stream referenced object checksums.
Validate candidate table mappings and recorded locator ranges, retain successful
validation reports, and reject damaged retained locator ranges during package
verification. Cancel verification without changing the selected build or pointer.

Compare stored candidate coordinates with parsed bounds to catch catalog-write
defects before sealing; independently verify installed imported builds without
their producer or sources.
