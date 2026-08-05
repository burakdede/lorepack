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

### Where `parserVersions` comes from

Derived from the parser registry, `PARSERS`, by `parserVersions()` in
`packages/cli/src/services/versions.ts`. Never written by hand.

That distinction is not stylistic. It was a hand-written literal naming markdown and text
until #234, and the five parsers Phase 5 added were never appended to it. The result was that
bumping the XLSX parser's version and rebuilding a project full of spreadsheets produced a
byte-identical build id: a parser fix could not invalidate the artifacts it changed, and
`lore diff` reported no difference between two builds whose content genuinely differed.
Deriving it makes registering a parser and recording its version one act rather than two that
have to be kept in step.

It records **every registered parser**, not only the ones a project used. The narrower rule is
tempting, because it would mean adding a parser to Lorepack cannot disturb the id of a project
containing no files of that type, but it fails on both counts. The lockfile is written during
planning, before anything is parsed, so the contributing set is not known when it is needed.
And the stability is imaginary: `compilerVersion` is already an input, and a release that adds
a parser bumps it, so every id moves anyway.

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

## Rules in build identity

Resolved rules are an input to `deriveBuildId` (section 11.4), so editing a rule produces a
different build. That is what makes `lore diff` able to show a precedence change, and what
stops an activation from silently keeping the old ranking.

What is hashed is what a rule **decided**, not how it was written:

- Two configurations whose rules resolve to the same statuses, authorities and supersessions
  produce the **same** build id. Someone tidying their `lore.yaml`, splitting a broad glob into
  two narrower ones, or reordering rules that do not overlap, does not rebuild the world.
- Changing any resolved value produces a different one.
- `matchedRules` is excluded deliberately. It is attribution for a human reading
  `lore inspect rules`, and hashing it would make reordering two rules that set the same value
  a rebuild for no difference in what the build contains.

Artifacts that no rule touched are omitted from the hashed form entirely, so a project with no
`rules:` block hashes an empty list and is unaffected by this stage existing.

The resolution also feeds the **parse cache key**. An artifact whose declared authority changed
has to be reindexed even though its bytes did not; resolving after the parse loop instead would
let a rule edit reuse a stale entry, which is precisely the failure the cache key exists to
prevent.
