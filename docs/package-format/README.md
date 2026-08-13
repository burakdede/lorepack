# Lorepack Package Format

This document is the normative specification for `.lorepack` archives and sealed build
metadata at `formatVersion: 1`. It is written for an independent reader implementation.
The committed JSON Schemas are linked where they define the machine contract.

Normative keywords such as MUST, MUST NOT, SHOULD and MAY are used intentionally.

## Public Schemas

`schemas/*.json` are generated from the Zod definitions in `@lorepack/core`. Zod is the
single source of truth, and `pnpm schemas:check` fails when committed schemas drift.

| Schema | Describes |
|---|---|
| [`schemas/lore-config.json`](../../schemas/lore-config.json) | `lore.yaml` |
| [`schemas/lore-lock.json`](../../schemas/lore-lock.json) | `lore.lock` |
| [`schemas/build-manifest.json`](../../schemas/build-manifest.json) | `manifest.json` inside a sealed build |
| [`schemas/build-receipt.json`](../../schemas/build-receipt.json) | Operational build receipt outside the build |
| [`schemas/plan.json`](../../schemas/plan.json) | `lore plan --json` |
| [`schemas/deployment-receipt.json`](../../schemas/deployment-receipt.json) | `.lore/targets/*` deployment receipt |
| [`schemas/search-request.json`](../../schemas/search-request.json), [`schemas/search-result.json`](../../schemas/search-result.json) | Search request and result |
| [`schemas/task-context-request.json`](../../schemas/task-context-request.json), [`schemas/context-bundle.json`](../../schemas/context-bundle.json) | Task context request and bundle |
| [`schemas/source-read-request.json`](../../schemas/source-read-request.json), [`schemas/source-read-result.json`](../../schemas/source-read-result.json) | Source read request and result |
| [`schemas/table-description.json`](../../schemas/table-description.json), [`schemas/table-query-request.json`](../../schemas/table-query-request.json), [`schemas/table-query-result.json`](../../schemas/table-query-result.json) | Table surface |
| [`schemas/build-description.json`](../../schemas/build-description.json) | Build description returned by runtime interfaces |

All public schemas use JSON Schema draft 2020-12.

## Project Files

A Lorepack project has these persisted inputs:

| Path | Required | Semantics |
|---|---:|---|
| `lore.yaml` | yes | Project name, source roots, rules, context defaults, package options and targets. Effective configuration is a build ID input after defaults are applied and secrets or absolute host paths are removed. |
| `lore.lock` | yes after first build | Compiler, schema, parser and semantic profile versions. `lore build --frozen` MUST fail when these versions drift. |
| `.lore/state.sqlite` | no | Local operational state: active pointer, build records and generations. It is not part of a sealed build and MUST NOT affect build identity. |
| `.lore/builds/lore_<sha256>/` | no | Immutable sealed builds. Once sealed, a build directory MUST NOT be migrated or mutated in place. |
| `.lore/objects/sha256/` | no | Content-addressed normalized source bodies. Objects are addressed by SHA-256 digest. |
| `.lore/cache/` and `.lore/tmp/` | no | Parser cache and candidates. These are operational and MUST NOT affect build identity. |
| `.lore/targets/` | no | Deployment receipts and target state. These are operational and MUST NOT affect build identity. |

## Build Directory Contents

A sealed build directory is named by its build ID and MUST contain:

| Path | Semantics |
|---|---|
| `manifest.json` | Build manifest validated by [`schemas/build-manifest.json`](../../schemas/build-manifest.json). |
| `context.sqlite` | Read-only catalog database for this build. Physical SQLite bytes are excluded from build identity. |
| `reports/warnings.json` | Build warnings shown after sources move or rollback occurs. |
| `reports/canonical-hashes.json` | Hash algorithm, canonicalization version and canonical roots used by the build. |

The build directory MAY reference normalized source objects stored outside the build under
`.lore/objects/sha256/`. Readers MUST treat the manifest and catalog as build data and
MUST NOT read source files to answer runtime requests for a sealed build.

## Archive Structure

A `.lorepack` file is a standard ZIP archive. It MUST NOT require encryption, proprietary
framing or a Lorepack-specific container reader. A normal ZIP tool must be able to list it.

Members MUST be written in this order:

1. `manifest.json`
2. `checksums.json`
3. `context.sqlite`
4. `reports/*`, sorted lexicographically by archive path
5. `objects/sha256/xx/yy/rest`, sorted lexicographically by archive path
6. `originals/*`, only when `package.includeOriginals: true`, sorted lexicographically by archive path

Every archive member MUST use a POSIX path. Every member timestamp MUST be normalized to
`1980-01-01T00:00:00Z`, and file entries SHOULD use mode `100644`. The current writer uses
deflate compression.

`checksums.json` has this shape:

```json
{
  "formatVersion": 1,
  "algorithm": "sha256",
  "members": {
    "manifest.json": "64 lowercase hex characters"
  }
}
```

The checksum index MUST contain every member except `checksums.json`. A reader MUST fail
verification when a listed member is missing, when its SHA-256 digest differs, or when the
archive contains an unlisted member. Member checksums detect corruption. They are not build
identity.

## Manifest Fields

The manifest is strict: unknown fields are invalid for `formatVersion: 1`.

| Field | Required | Type | Semantics |
|---|---:|---|---|
| `formatVersion` | yes | literal `1` | Public package-format major version. |
| `buildId` | yes | `lore_` plus 64 lowercase hex characters | Content-derived build identifier from the inputs in [Build ID Derivation](#build-id-derivation). |
| `projectName` | yes | non-empty string | Project name from `lore.yaml`. |
| `compilerVersion` | yes | non-empty string | Lorepack compiler version recorded in `lore.lock`. |
| `schemaVersion` | yes | positive integer | Build catalog schema version. A sealed build is never migrated in place. |
| `configurationHash` | yes | 64 lowercase hex characters | `hashCanonical(effectiveConfig)`. |
| `sourceFingerprint` | yes | 64 lowercase hex characters | Canonical fingerprint of source identity used by incremental rebuild logic. |
| `canonicalRoots` | yes | object | Logical roots over the build's canonical records. |
| `canonicalRoots.artifacts` | yes | 64 lowercase hex characters | Root over artifact ID and artifact content hash records. |
| `canonicalRoots.nodes` | yes | 64 lowercase hex characters | Root over normalized node revision hashes. |
| `canonicalRoots.chunks` | yes | 64 lowercase hex characters | Root over chunk revision hashes. |
| `canonicalRoots.tables` | yes | 64 lowercase hex characters | Root over table ID, column definitions and row values. Empty when no table exists. |
| `canonicalRoots.objects` | yes | 64 lowercase hex characters | Root over normalized object SHA-256 digests. |
| `capabilities` | yes | array of enum strings | Capabilities present in this build, not every capability the compiler can implement. |
| `embeddingProfile` | no | object | Required when `capabilities` contains `semantic-search`. |
| `embeddingProfile.modelId` | yes when `embeddingProfile` exists | non-empty string | Embedding model identity. |
| `embeddingProfile.revision` | yes when `embeddingProfile` exists | non-empty string | Exact model revision. |
| `embeddingProfile.tokenizer` | yes when `embeddingProfile` exists | non-empty string | Tokenizer identity. |
| `embeddingProfile.pooling` | yes when `embeddingProfile` exists | `mean` or `cls` | Vector pooling strategy. |
| `embeddingProfile.normalized` | yes when `embeddingProfile` exists | boolean | Whether vectors are normalized. |
| `embeddingProfile.dimensions` | yes when `embeddingProfile` exists | positive integer | Vector dimensions. |
| `embeddingProfile.valueType` | yes when `embeddingProfile` exists | literal `float32` | Stored vector numeric type. |
| `counts` | yes | object | Row counts for reader planning and diagnostics. |
| `counts.artifacts` | yes | non-negative integer | Number of artifacts. |
| `counts.nodes` | yes | non-negative integer | Number of normalized nodes. |
| `counts.chunks` | yes | non-negative integer | Number of chunks. |
| `counts.tables` | yes | non-negative integer | Number of tables. |
| `counts.tableRows` | yes | non-negative integer | Number of table rows. |
| `warnings` | yes | array | Warnings sealed with the build. Warnings are not build ID inputs. |
| `warnings.code` | yes | non-empty string | Stable warning code. |
| `warnings.message` | yes | non-empty string | Human-readable warning message. |
| `warnings.path` | no | canonical path | Source path when a warning is tied to one path. |
| `warnings.class` | yes | enum string | One of `unsupported-file`, `parser`, `envelope`, `rule` or `security`. |
| `exclusions` | no | array | Ignore-rule exclusions. Absent means the build does not know, not that nothing was excluded. |
| `exclusions.pattern` | yes | non-empty string | Rule text as written. |
| `exclusions.source` | yes | non-empty string | Rule source, such as built-in defaults or `.loreignore`. |
| `exclusions.count` | yes | positive integer | Number of paths removed by this rule. A pruned directory counts once. |
| `exclusions.sample` | yes | array of non-empty strings | Sorted, capped sample of removed paths. |

## Canonical Serialization

`formatVersion: 1` uses `canonicalizationVersion: 1` and SHA-256. Canonical serialization is
not JSON. It is a length-prefixed grammar:

| Value | Encoding |
|---|---|
| `null` | `n` |
| string | `s<length>:<value>` where length is JavaScript string length |
| boolean | `b1` for true, `b0` for false |
| integer | `i<length>:<base10>` |
| finite non-integer number | `i<length>:<Number.toPrecision(17)>` |
| non-finite number | `x`, rejected upstream by schemas |
| array | `a<count>:<encoded items in order>` |
| object | `o<count>:<encoded key><encoded value>...` with keys sorted lexicographically |

`hashCanonical(value)` is `sha256(canonicalize(value))`.

`hashRoot(memberHashes)` sorts member hashes lexicographically, prefixes the count as
`r<count>:`, appends each hash as text, and hashes the resulting bytes with SHA-256. The
empty root is therefore the root of an empty sorted list, not a magic constant.

## Build ID Derivation

The build ID is:

```text
lore_ + hashCanonical(buildIdInputs)
```

`buildIdInputs` MUST contain exactly these fields:

| Field | Semantics |
|---|---|
| `formatVersion` | Public package-format version. |
| `schemaVersion` | Build catalog schema version. |
| `compilerVersion` | Compiler version that produced the build. |
| `canonicalizationVersion` | Canonical serializer version. |
| `normalizationVersion` | Canonical path and text normalization version. |
| `effectiveConfig` | Effective configuration with defaults applied and secrets or absolute paths removed. |
| `parserVersions` | Parser identifier to version for every parser that contributed. |
| `ruleResolution` | Resolved rule decisions per artifact in canonical sorted form. |
| `embeddingProfile` | Complete semantic profile, or `null`. |
| `canonicalRoots` | `artifacts`, `nodes`, `chunks`, `tables` and `objects` roots. |

These facts MUST NOT affect build identity: timestamps, hostname, absolute workspace path,
temporary directory, deployment target, ZIP metadata, `checksums.json`, build receipts and
physical SQLite bytes.

## Lockfile

`lore.lock` is validated by [`schemas/lore-lock.json`](../../schemas/lore-lock.json). It
records every version that can change deterministic output:

| Field | Required | Semantics |
|---|---:|---|
| `formatVersion` | yes | Lockfile format version. |
| `compiler` | yes | Compiler version. |
| `schema` | yes | Build catalog schema version. |
| `parsers` | yes | Parser identifier to version map. |
| `semantic` | yes | Complete embedding profile or `null`. |

A frozen build MUST fail when the lockfile and current version inputs differ.

## Build States

Build states are operational labels, not identity inputs:

| State | Meaning |
|---|---|
| `planned` | A plan exists, but no candidate is being written. |
| `building` | A local candidate is being compiled. |
| `validating` | Candidate validation is running. |
| `verified` | Candidate validation passed and the build is sealed. |
| `failed` | A candidate failed. The active pointer is unchanged. |
| `active` | The local active pointer names this build. |
| `packed` | A `.lorepack` archive was written. |
| `projected` | A remote projection candidate was written. |
| `remotely_verified` | Remote projection verification passed. |
| `remotely_active` | The remote active pointer names this build. |

Activation and rollback are pointer changes. Rollback MUST NOT recompile.

## Receipt Separation

Build receipts and deployment receipts record operational facts: wall-clock time, duration,
platform, Node version, cache counts, deployment target and remote proof. They live outside
the canonical build because two machines can produce the same logical build while disagreeing
about those facts.

Readers MUST use receipts for diagnostics and audit trails only. They MUST NOT use receipts
to derive or validate `buildId`.

## Worked Example

The committed example is [`worked-example.json`](worked-example.json). It contains a one-file
Markdown build with one artifact, one node, one chunk and no tables.

The example records the member hashes, canonical roots, complete build ID inputs and manifest.
Using the rules above, an implementation MUST derive:

```text
lore_7109c946e90daf364dacd1699d807a84a2785df75bf1541ef57d9dcf67af184e
```

The manifest in the example is valid against
[`schemas/build-manifest.json`](../../schemas/build-manifest.json).

## Compatibility Policy

`formatVersion` is the package-format major version.

Additive changes within `formatVersion: 1`:

- adding an optional field to a schema;
- adding a new enum value only when readers can safely ignore the value and still preserve
  the build rather than misinterpret it;
- adding a new report file that is listed in `checksums.json` and not required for existing
  readers.

Changes that require a `formatVersion` bump:

- making an optional field required;
- removing a field;
- changing a field's meaning;
- changing canonical serialization;
- changing the build ID input list;
- changing archive member ordering or checksum rules;
- changing a schema so old readers would accept a build but interpret it incorrectly.

A reader that sees an unknown `formatVersion` MUST refuse the document or archive. It MUST
NOT guess. For known `formatVersion: 1`, current schemas are strict, so unknown manifest
fields are invalid.

## Third-Party Reader Checklist

- Validate `manifest.json` against [`schemas/build-manifest.json`](../../schemas/build-manifest.json).
- Reject an unknown `formatVersion`.
- Confirm `buildId` equals `lore_` plus `hashCanonical(buildIdInputs)` when the required
  logical inputs are available.
- Verify `checksums.json` covers every archive member except itself, with no missing,
  mismatched or unlisted member.
- Treat `context.sqlite` as read-only build data and never migrate it in place.
- Preserve `SourceLocator` values returned by runtime APIs.
- Treat `authority`, `status` and `supersedes` as user-declared ranking hints, not detected truth.
- Keep receipts outside identity and use them only for diagnostics.
