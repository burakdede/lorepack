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
| parsers | `rehype-parse` | 9.0.1 | HTML to a structured tree with source positions. Checked 2026-08-04: MIT, three dependencies all inside the unified collective, no native code, no post-install script, 6.9M weekly downloads. Low release churn because it is a mature specification-tracking parser rather than a dormant one: it implements the HTML parsing algorithm, which does not move. Chosen over a regex or a DOM shim because it reports `{line, column, offset}` for every element, which is what makes exact locators possible, and because it is the same toolchain as Markdown, so heading stacking and node construction are shared rather than written twice. |
| parsers | `pdfjs-dist` | 6.2.108 | Text extraction from PDFs. Checked 2026-08-04: Apache-2.0, Mozilla, **zero runtime dependencies**, no post-install script, published 2026-07-28, 24 releases in two years, 22.1M weekly downloads. Pinned to a tested patch because extraction output is build-id affecting. **35 MB installed**, the heaviest thing in the tree, which is the price of a pure-JS PDF engine and cheaper than the alternative, since every native option breaks invariant 7. Its `@napi-rs/canvas` optional dependency is excluded in `pnpm-workspace.yaml`; see [`parsers.md`](./parsers.md#pdf). |
| parsers | `mammoth` | 1.12.0 | DOCX to semantic HTML, which the HTML parser then turns into nodes. Checked 2026-08-04: BSD-2-Clause, no native code, no post-install script, published 2026-03-12, five releases in two years, 6.9M weekly downloads. Chosen because it maps Word **styles** to meaning rather than reproducing visual formatting, which is invariant 8. Unlike the XLSX candidates it meets the maintenance bar, and the job is far larger: style inheritance, numbering, footnotes and revisions. It pulls `jszip`, a second ZIP implementation alongside `yauzl`, accepted deliberately and recorded in [`parsers.md`](./parsers.md#docx). Re-check due 2026-08-04 plus one year. |
| parsers | `csv-parse` | 7.0.2 | Delimited text. Vetted 2026-08-04 by installing and running it: MIT, **zero dependencies**, no install or postinstall script, no native code, 1.7 MB installed, published 2026-08-02 with six releases in the preceding thirteen months. Chosen for correct RFC 4180 quoting, a `delimiter` candidate list that gives dialect detection, and `relax_quotes` for the bare quotes real exports contain. Measured: it never coerces, so `"00123"` arrives as a string and the type decision stays ours. Lorepack reads **arrays, not `columns: true`**, because that option silently collapses duplicate headers and discards extra cells; see [`parsers.md`](./parsers.md#reading-the-grid-as-arrays-on-purpose). |
| cli | `commander` | 15.0.0 | Argument parsing only. Chosen for `exitOverride` and `configureOutput`, which let the shell own every exit code and every byte of error output rather than letting the parser call `process.exit`. |
| backend-local | `yazl` | 3.3.1 | Writing `.lorepack`. Deterministic archives need explicit control over entry order, timestamps and whether a data descriptor is written; `yazl`'s `addBuffer` gives exactly that. Convenience wrappers hide the metadata that determinism depends on. |
| backend-local, parsers | `yauzl` | 3.4.0 | Reading and verifying `.lorepack`, and reading the ZIP container an XLSX file is. Same author as `yazl`, same low-level control, and it handles zip64 so a large build does not need a second code path. Shared with `parsers` by the XLSX decision in [`adr-xlsx-parser.md`](./adr-xlsx-parser.md), which is a point in its favour: the format reader adds no new archive dependency. |
| cli | `@hono/node-server` | 2.0.12 | Serving the Hono app on Node for `lore serve`. Checked 2026-08-03: MIT, no runtime dependencies, 120 KB unpacked, no native code. The adapter exists because Node has no `fetch`-style server; a Worker needs none of this, which is why the edge is on the CLI and not on `runtime`. |
| cli, mcp | `@modelcontextprotocol/server`, `/node` | 2.0.0 | The MCP protocol implementation, pinned per architecture 8.6 and isolated so protocol churn never reaches the compiler or the storage schema. v2 replaced the monolithic `@modelcontextprotocol/sdk`, which is frozen at 1.30.0. Checked 2026-08-03: MIT, published 2026-07-28. It serves the current 2026-07-28 revision **and** the superseded handshake era; its exported `LATEST_PROTOCOL_VERSION` names the latter, so read `MCP_PROTOCOL_VERSION` from `@lorepack/mcp` instead (see [`serving.md`](./serving.md)). |
| cli | `chokidar` | 5.0.0 | Filesystem events for `lore dev`'s watch mode. Checked 2026-08-03: MIT, one dependency (`readdirp`), 82 KB unpacked, no native code, no post-install script, published 2026-05-21. Pinned to v5 because v4 removed glob support and v5 is ESM-only with named exports, both of which change how it is called. It is an **accelerator, not a source of truth** (architecture 24.5): it decides when to look, and content hashes decide what changed, which is why losing an event degrades to a slower rebuild rather than to a wrong one. |
| parsers | `sax` | 1.6.1 | Streaming XML for the read-only XLSX reader. Checked 2026-08-04: BlueOak-1.0.0, **zero dependencies**, 80 KB unpacked, no native code, no post-install script, published 2026-07-24, 85.5M weekly downloads. It is here because **no maintained XLSX library met the requirements**: the capable one is unmaintained and ships a permanent advisory, the maintained one cannot return formula text. Streaming matters twice over: it is what keeps the 500,000-row envelope at 85 MB rather than 297 MB, and refusing a `DOCTYPE` at the parser is the entity-expansion defence section 20.9 asks for. The reasoning and the measurements are in [`adr-xlsx-parser.md`](./adr-xlsx-parser.md). |
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
