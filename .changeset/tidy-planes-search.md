---
'@lorepack/core': minor
---

`buildDescription` gains an optional `createdAt`. A sealed build carries no wall-clock time
by design, so identical content produces identical bytes; the creation time is operational
state the serving backend records beside the build, and a backend without that record omits
the field.

Adds the `CatalogArtifact` and `CatalogNode` ports, and `RUNTIME_LIMITS`, which is
deliberately separate from `PRODUCT_DEFAULTS.limits`: those are compilation inputs hashed
into the build id, and how much text one read returns decides nothing about what a build
contains.
