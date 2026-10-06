# @lorepack/core

## 0.1.0-alpha.0

### Minor Changes

- c97256d: Add `LORE_E_SOURCE_UNREADABLE` (exit 1) for a source file that exists and cannot be opened.
  It used to surface as `LORE_E_INTERNAL` with a raw errno, which told the user to report a
  bug for a permission they could fix. Error codes are part of the public contract, so the
  addition is recorded here.

  The fallback `next:` line no longer names `lore doctor`, which does not exist until Phase 3.

- 6976d0b: `buildDescription` gains an optional `createdAt`. A sealed build carries no wall-clock time
  by design, so identical content produces identical bytes; the creation time is operational
  state the serving backend records beside the build, and a backend without that record omits
  the field.

  Adds the `CatalogArtifact` and `CatalogNode` ports, and `RUNTIME_LIMITS`, which is
  deliberately separate from `PRODUCT_DEFAULTS.limits`: those are compilation inputs hashed
  into the build id, and how much text one read returns decides nothing about what a build
  contains.

### Patch Changes

- f899e7a: Reject source roots that normalize to the same source ID or overlap, and report filesystem
  entries that cannot be inspected as `unreadable` discovery warnings.
