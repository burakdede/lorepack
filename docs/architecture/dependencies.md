# Runtime dependencies

Every runtime dependency is listed here with the reason it exists. Stars and popularity are
not evidence (working agreement §9); what matters is that the library is maintained, that
its capability matches an actual need, and that it costs the user nothing on first run.

Two constraints bound every choice:

- **Zero-surprise first run.** No native add-ons, no post-install scripts, no compiler
  toolchain. `pnpm check:no-native` enforces this in CI, so a dependency that pulls in a
  native module fails the build rather than the user's install.
- **Ports and adapters.** `core` may not depend on a parser, a database, a protocol or a
  cloud SDK. The dependency list per package is part of that boundary, and `pnpm arch`
  enforces the import direction.

## The list

| Package | Dependency | Version | Why this one |
|---|---|---|---|
| core | `zod` | 4.4.3 | Schema definitions and the source of the published JSON Schemas. Zod 4 emits draft-2020-12 natively through `z.toJSONSchema`, which is the dialect MCP requires, so there is no second schema representation to keep in sync. |
| core, compiler, parsers | `yaml` | 2.9.0 | `lore.yaml`, `lore.lock` and frontmatter. Preserves comments and gives real error positions, which is what makes a configuration error actionable. `JSON.parse` cannot read the format users write. |
| compiler | `picomatch` | 4.0.5 | Glob matching for `include`, `exclude` and `.loreignore`. Dependency-free, and it implements the gitignore semantics users already expect. |
| parsers | `unified`, `remark-parse`, `remark-gfm`, `remark-frontmatter`, `mdast-util-from-markdown` | 11.x / 11.0.0 / 4.0.1 / 5.0.0 / 2.0.2 | Markdown to a structured tree with positions. Structure before models (invariant 8) needs headings, lists and tables as nodes with line ranges, which a regex splitter cannot produce. The remark ecosystem is the reference implementation of CommonMark plus GFM in JavaScript. |
| cli | `commander` | 15.0.0 | Argument parsing only. Chosen for `exitOverride` and `configureOutput`, which let the shell own every exit code and every byte of error output rather than letting the parser call `process.exit`. |
| backend-local | `yazl` | 3.3.1 | Writing `.lorepack`. Deterministic archives need explicit control over entry order, timestamps and whether a data descriptor is written; `yazl`'s `addBuffer` gives exactly that. Convenience wrappers hide the metadata that determinism depends on. |
| backend-local | `yauzl` | 3.4.0 | Reading and verifying `.lorepack`. Same author, same low-level control, and it handles zip64 so a large build does not need a second code path. |
| cli | `@hono/node-server` | 2.0.12 | Serving the Hono app on Node for `lore serve`. Checked 2026-08-03: MIT, no runtime dependencies, 120 KB unpacked, no native code. The adapter exists because Node has no `fetch`-style server; a Worker needs none of this, which is why the edge is on the CLI and not on `runtime`. |
| cli, mcp | `@modelcontextprotocol/server`, `/node` | 2.0.0 | The MCP protocol implementation, pinned per architecture 8.6 and isolated so protocol churn never reaches the compiler or the storage schema. v2 replaced the monolithic `@modelcontextprotocol/sdk`, which is frozen at 1.30.0. Checked 2026-08-03: MIT, published 2026-07-28. It serves the current 2026-07-28 revision **and** the superseded handshake era; its exported `LATEST_PROTOCOL_VERSION` names the latter, so read `MCP_PROTOCOL_VERSION` from `@lorepack/mcp` instead (see [`serving.md`](./serving.md)). |
| runtime | `hono` | 4.12.33 | The HTTP surface. Chosen in architecture 8.5 because the same route handlers run on Node and on a Worker, which is what makes the Phase 6 projection a configuration change rather than a rewrite. Checked 2026-08-03: MIT, zero runtime dependencies, 1.36 MB unpacked, no native code, no post-install script, last release three days earlier. The zero-dependency part matters most: an HTTP framework is the usual place a transitive tree arrives. |

`node:sqlite`, `node:crypto` and `node:zlib` are used directly and are deliberately not
dependencies. That is the reason the supported Node floor is 24.15: see
[`docs/compatibility/sqlite-fts5.md`](../compatibility/sqlite-fts5.md).

## Adding one

Before adding a dependency, check and record: last release, open CVEs, licence, install
weight, whether it ships native code, and whether it runs a post-install script. Then add a
row above with the capability it provides, not the problem it solves in general. If an
existing dependency or a Node builtin can do the job, that is the answer.

Prefer a small amount of our own code over a dormant dependency when the code is
genuinely small and fully testable. `ProjectLock` is the standing example: `proper-lockfile`
has had no release since 2022, and the mkdir-based lock it replaces is under a hundred
lines with cross-platform tests of its own.
