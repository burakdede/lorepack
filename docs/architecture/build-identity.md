# Build identity

A build ID is `lore_` followed by the full lowercase SHA-256 of the build's canonical
logical inputs. Two machines with different operating systems, different absolute paths,
and different filesystem enumeration order must produce the same ID from the same
sources. That property is what makes a build a version rather than a snapshot.

## What goes in

Architecture section 11.4 fixes the list, and `BuildIdInputs` is that list expressed as a
type. A caller cannot accidentally contribute something else, because there is no field
for it.

| Input | Why it belongs |
|---|---|
| `formatVersion`, `schemaVersion` | A format change alters what the build means |
| `compilerVersion` | Only where output semantics depend on it |
| `canonicalizationVersion`, `normalizationVersion` | Serialization and text normalization policies feed every hash |
| `effectiveConfig` | Secrets and absolute paths already removed by the caller |
| `parserVersions` | A parser upgrade legitimately changes extracted structure |
| `ruleResolution` | Status, authority and supersession change what is served |
| `embeddingProfile` | Complete profile, or `null`. Matching dimensions is not compatibility |
| `canonicalRoots` | Artifacts, nodes, chunks, tables, objects |

## What stays out, deliberately

Operational timestamps, machine name, absolute workspace path, temporary directory,
deployment target, ZIP container metadata, and the physical byte layout of
`context.sqlite`.

The last one is the audit finding from section 1.5 and the reason identity is *logical*
rather than physical: SQLite page layout can differ across platforms and patch releases
for a database that is logically identical. Treating those bytes as canonical would make
the portability promise depend on file-layout details nobody controls.

Operational facts live in the build receipt in `state.sqlite`, outside the build and
outside `.lorepack`, so two machines can agree on identity while disagreeing about how
long the build took.

## Canonical serialization

Two properties do the work:

- **Stable ordering.** Object keys sort before serialization, so insertion order cannot
  change a hash.
- **Length prefixes.** Every scalar and container is prefixed with its length, so
  concatenation is unambiguous. Without this, `["ab","c"]` and `["a","bc"]` would hash
  identically, and a chunk boundary change could pass unnoticed. There is a test for
  exactly that.

Types are tagged, so the string `"1"` and the number `1` never collide.

## Roots

`hashRoot` sorts member hashes and includes the count. Sorting means the root does not
depend on the order records happened to be produced in; the count means a dropped member
cannot be masked by a coincidence.

## Display

Manifests, APIs, receipts and directory names always carry the full 64-character digest.
Only humans see the short form: `formatBuildId` returns the shortest unambiguous prefix
with a floor of 12 characters, lengthening only when another known build shares it.

`resolveBuildIdPrefix` is the inverse for user input: unique prefixes resolve, unknown
ones fail with the listing command, ambiguous ones fail listing the candidates.

## Changing any of this

Adding an input, changing the canonicalization, or changing the normalization policy
changes every build ID in existence. Each is therefore a versioned constant, and the
change is a reviewed, format-affecting act that needs a changeset.
