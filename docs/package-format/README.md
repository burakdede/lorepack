# Package format

The normative `.lorepack` specification lands with #94. This page covers what exists now:
the public JSON Schemas, and the policy that governs them.

## Schemas

`schemas/*.json` are generated from the Zod definitions in `@lorepack/core`. Zod is the
single source of truth; the JSON Schemas are committed so an external tool can validate a
manifest, a config, or an API payload without installing Lorepack or writing TypeScript.

| Schema | Describes |
|---|---|
| `lore-config` | `lore.yaml` |
| `lore-lock` | `lore.lock` |
| `build-manifest` | `manifest.json` inside a build |
| `build-receipt` | Operational record in `state.sqlite`, outside the build |
| `plan` | `lore plan --json` |
| `deployment-receipt` | `.lore/targets/*` deployment receipt |
| `search-request`, `search-result` | `POST /v1/search` and `lore_search` |
| `task-context-request`, `context-bundle` | `POST /v1/context` and `lore_context_for_task` |
| `source-read-request`, `source-read-result` | `GET /v1/sources/:id` and `lore_read_source` |
| `table-description`, `table-query-request`, `table-query-result` | Table surface |
| `build-description` | `GET /v1/build` and `lore_build_info` |

All are draft-2020-12, which is also the dialect the Model Context Protocol requires, so
one definition serves the REST contract and the MCP tool schema without translation.

## Generating and checking

```bash
pnpm schemas:generate   # rewrite schemas/ from Zod
pnpm schemas:check      # fail when they drift, part of pnpm verify and CI
```

The check also fails on a stale file with no matching Zod schema, so deleting a contract
cannot leave an orphan behind.

## Invariants encoded in the schemas

These are contract rules, not merely types, so a malformed document is rejected at the
boundary rather than deep inside a pipeline:

- A build advertising `semantic-search` must carry a complete `EmbeddingProfile`. Matching
  dimensions alone is not compatibility, so the profile carries model, revision, tokenizer,
  pooling, normalization and value type.
- A context bundle may never report more estimated tokens than its budget.
- A canonical path carries no backslash, no leading slash and no drive letter.
- `authority` is an integer from 0 to 100 and is described in the schema as a ranking hint,
  not a measure of truth.
- Every object is `strict`, so an unknown key is an error rather than silently ignored.
- A source read must name either an artifact or a path.

## Compatibility policy

`formatVersion` is explicit in every persisted document. Within a major format version:

- adding an optional field is additive and does not bump it;
- making a field required, removing a field, or changing its meaning bumps it;
- readers encountering an unknown `formatVersion` must refuse rather than guess.

Schemas are part of the public contract, so a change needs a changeset.
