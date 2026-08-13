# Architecture

Lorepack has four planes. Keeping them separate is how the build remains the source of truth.

| Plane | Owns | Main docs |
|---|---|---|
| Compiler | Canonical source discovery, parsing, indexing, validation and build sealing | [`build-orchestration.md`](build-orchestration.md), [`build-identity.md`](build-identity.md), [`parsers.md`](parsers.md) |
| Runtime | Read-only projection of one immutable build | [`serving.md`](serving.md), [`retrieval.md`](retrieval.md), [`local-storage.md`](local-storage.md) |
| Control | CLI, Studio and local lifecycle operations | [`cli.md`](cli.md), [`studio.md`](studio.md), [`watch.md`](watch.md) |
| Deployment | Remote projection and target receipts | [`deployment.md`](deployment.md), [`adr-cloudflare-worker-stateless.md`](adr-cloudflare-worker-stateless.md) |
| Security | Threat model, security surfaces and pre-release review | [`threat-model.md`](threat-model.md), [`security.md`](security.md), [`security-review.md`](security-review.md) |
| Supply chain | Dependency policy, provenance and SBOM release checks | [`dependencies.md`](dependencies.md), [`release-supply-chain.md`](release-supply-chain.md) |

## Dependency rules

The package graph is one-way:

| Package area | May depend on | Must not import |
|---|---|---|
| `@lorepack/core` | standard library only | parsers, SQLite, CLI, MCP, Cloudflare, Studio |
| parsers and compiler | `core` and parser-local helpers | runtime, CLI, deployment targets |
| runtime and MCP | `core` plus runtime adapters | compiler, source parsers, Studio |
| CLI and Studio hosts | public ports and adapters | private implementation files across package boundaries |
| deployment adapters | runtime ports and target-specific code | source compiler internals |

`pnpm test:arch` enforces the import direction. Dependency additions are recorded in
[`dependencies.md`](dependencies.md), including why the package does not violate the
zero-surprise install rule.

## Storage and runtime ports

`core` defines narrow contracts and data shapes. Adapters implement them:

| Port | Canonical implementation | Boundary |
|---|---|---|
| project state and build records | local SQLite under `.lore/` | local control plane |
| immutable build catalog | sealed SQLite plus normalized object bodies | build and runtime |
| `LoreRuntime` | local build runtime, Cloudflare projection runtime | read-only AI boundary |
| `BuildComparer` | local build history comparer | optional host capability |
| deployment target | Cloudflare adapter | remote projection, not compilation |

Every runtime answer carries a build id and source locators. A model-facing surface has no port
for source edits, shell execution, deploy, build, activate or rollback.

## Compiler pipeline

`lore build` runs this sequence:

```text
lock -> plan -> parse -> index -> validate -> seal -> record -> activate
```

The candidate is written outside the active build set until validation passes. The build id is
derived from canonical logical content, not SQLite bytes, timestamps or absolute paths. Details
are in [`build-orchestration.md`](build-orchestration.md) and
[`build-identity.md`](build-identity.md).

## Activation semantics

Activation is a pointer change. Rollback is also a pointer change. Neither operation recompiles,
and each verifies that the target build opens before moving the pointer. A failed build or failed
deploy can leave temporary files or a receipt, but it cannot corrupt the active build.

## Error taxonomy

Every user-visible failure is a typed `LoreError` with a stable code, exit classification and
remediation. CLI, JSON, REST and MCP render the same condition in their own formats from the
same code. See [`errors.md`](errors.md).

## Testing strategy

The minimum gate is `pnpm verify`. The current suite combines architecture rules, formatting,
typechecking, unit and integration tests, schema drift checks, docs checks, source tracking,
SQLite FTS5 probing and acceptance-doc generation. Cross-platform CI runs the verify job on
Ubuntu, Windows and macOS with Node 24.18.1. See [`testing.md`](testing.md) and
[`ci.md`](ci.md).

## ADR table

| Decision | Record |
|---|---|
| SQL surface and authorizer boundary | [`adr-sql-surface.md`](adr-sql-surface.md) |
| TOML splice writer for Codex config | [`adr-toml-merge.md`](adr-toml-merge.md) |
| XLSX parser choice | [`adr-xlsx-parser.md`](adr-xlsx-parser.md) |
| Stateless Cloudflare Worker projection | [`adr-cloudflare-worker-stateless.md`](adr-cloudflare-worker-stateless.md) |
