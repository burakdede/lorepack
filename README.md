# Lorepack

**Build, version, and deploy the context your AI depends on.**

Lorepack compiles a directory of documents, spreadsheets and project artifacts into an
**immutable, content-addressed build** that can be inspected, diffed, deployed, activated
and rolled back, then read by chat models and coding agents over MCP, HTTP, or a bounded
export.

Think *Git and Terraform for AI context*. It is not another local RAG server: retrieval is
a runtime capability, the build lifecycle is the product.

```text
source artifacts → plan → deterministic build → immutable version
                 → validate → activate atomically → diff / roll back
```

## Try The Lifecycle

```bash
lore dev ./project-context     # discover, build, serve, watch, and print where everything is
lore connect claude-code       # configure an AI client, and prove it answers
```

Those two commands are the quick start once the package is installed. From a clone today, use
the built entry point:

```bash
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/entry.js dev ./examples/product-research
node packages/cli/dist/entry.js --cwd examples/product-research connect claude-code --dry-run
```

The three-minute demo is a lifecycle, not a search box:

```bash
pnpm demo:readme
```

That committed script copies the checked-in examples to a temp directory, runs the real CLI, and
regenerates [`docs/demo-transcript.md`](docs/demo-transcript.md). CI runs
`pnpm demo:readme:check`, so the transcript cannot drift.

The demo proves four steps:

| Step | What happens | Command family |
|---|---|---|
| Start | inspect the plan, build and activate an immutable version | `lore plan`, `lore build` |
| Change | edit a source and see exactly what will rebuild | `lore plan` |
| Recover | diff builds, roll the active pointer back, never recompile | `lore diff`, `lore rollback` |
| Deploy | produce and verify the portable artifact; remote deploy follows target setup | `lore pack`, then `lore target add cloudflare` and `lore deploy cloudflare` |

![lore init and lore build](docs/images/cli-build.svg)

Everything the build decided is inspectable without re-running it, including the decisions
that removed a file:

![lore status and lore inspect exclusions](docs/images/cli-inspect.svg)

Every result carries the file, the heading path and the lines it came from. A result without
one is a bug, not a style issue:

![lore search, with provenance on every hit](docs/images/cli-search.svg)

## Status

**Pre-v0.1. Under active construction, not yet published.**

Everything shown here runs today from a clone, and the images are generated from a real build by
`pnpm docs:capture`, but no package has been released. Follow along in the
[backlog](https://github.com/users/burakdede/projects/8).

Working now: the local lifecycle, every parser below, typed tables with a read-only SQL
surface, declared precedence rules, retrieval with provenance, MCP and HTTP serving, the
`lore connect` flow for Claude Code, Codex and VS Code, Studio, and the Cloudflare projection
path.

## Studio

`lore dev` prints a Studio URL: six routes served from static files by the same process that
serves the API, on the same port, with no toolchain and no network.

![Studio Context Playground](docs/images/studio-playground.png)

The Playground answers the question that matters most before you trust any of this: **what
would a model actually receive for this task, and what was left out.** Every passage carries
its provenance, every omission carries its reason, and a ranking heuristic is labelled as one
rather than presented as a score of truth.

The other five are Overview, Sources, Tables, Versions and Diagnostics. Tables appears only
when the build has one, and its console runs a read-only `SELECT` through the same validator and
the same limits as the tool a model calls. [Take the tour](docs/studio-tour.md), with a
screenshot of each.

Studio is read-mostly. The only routes that change anything exist solely under `lore dev`, and
they refuse any browser origin that is not a loopback literal.

## Requirements

Node.js `>=24.15 <25`, and that is the whole list. No Python, Docker, compiler toolchain,
native add-on, model download, API key or account.

The floor is 24.15 because that is the first release where `node:sqlite` exposes the
authorizer and per-connection limits the read-only SQL surface depends on. Lorepack also
needs SQLite compiled with FTS5, which every official Node build has; see
[SQLite FTS5 availability](docs/compatibility/sqlite-fts5.md) for the verified matrix and
what happens if yours does not.

## Installation

Two install paths are supported by the design:

| Path | Use when | Commands |
|---|---|---|
| Published package | after v0.1 is released | `pnpm add -g lorepack` or the package-manager equivalent |
| Source checkout | today, and for contributors | `pnpm install --frozen-lockfile && pnpm build` |

The zero-surprise first run is tested, not promised: no Python, Docker, compiler toolchain,
native add-on, post-install build, model download, API key or account. The clean-install CI
matrix installs with lifecycle scripts suppressed and then runs the product.

## Design commitments

- **The build is the source of truth.** Every runtime is a projection of an immutable build.
- **Deterministic.** Identical inputs produce an identical build ID on every OS.
- **Provenance always.** Every result traces to a file, section, page, sheet or cell range.
- **No surprises on first run.** No Python, Docker, compiler toolchain, native add-on,
  model download, API key or account.
- **Never invents truth.** Precedence between sources is declared by you, never guessed.

## Limitations, honestly

- **Markdown, HTML, DOCX, CSV, XLSX, text-layer PDF, plain text and source code.** A file with
  an extension Lorepack does not know is named in the build's exclusions rather than silently
  skipped. A scanned PDF is refused outright rather than indexed as an empty document: OCR is
  out of scope for v0.1.
- **A spreadsheet becomes a typed table, not prose**, queried with SQL rather than searched as
  text. Types are inferred conservatively and refuse to be clever: `00123` stays text, a
  19-digit id stays text, and `03/04/2026` stays text because the file never says which country
  wrote it. Excel formulas are stored as text and never evaluated. A worksheet whose layout is
  not a table is described and reported, never invented into one.
- **The SQL surface is one read-only SELECT over one table**, run in a process that is killed on
  a deadline, behind an authorizer that permits that table and nothing else in the build. It
  cannot write, cannot reach another table, and cannot read the catalog.
- **Lexical retrieval only.** BM25 with declared ranking hints. No embeddings in the default
  install, and the score is presented as a ranking heuristic because that is what it is. The
  Cloudflare target is lexical-only in v0.1.
- **No screenshots, OCR or image understanding.** Scanned PDFs are refused rather than indexed
  as empty content.
- **No PPTX.** Presentation parsing is out of scope for v0.1.
- **One project, one machine.** No tenancy, no accounts, no hosted control plane.
- **The scale envelope is 2,500 files and 1 GB.** Past that Lorepack asks you to confirm and
  says plainly that the behaviour is untested rather than unsupported.
- **Precedence is declared, never detected.** Lorepack will not tell you which of two documents
  is correct, and does not claim to have found a conflict.

## Documentation

| | |
|---|---|
| Working agreement for contributors and agents | [`AGENTS.md`](AGENTS.md) |
| Full architecture specification | [`Lorepack_Local_First_MVP_Architecture_Final.md`](Lorepack_Local_First_MVP_Architecture_Final.md) |
| How to contribute | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Governance and release authority | [`GOVERNANCE.md`](GOVERNANCE.md) |
| Reporting a vulnerability | [`SECURITY.md`](SECURITY.md) |
| Start page for the docs | [`docs/README.md`](docs/README.md) |
| Package format specification | [`docs/package-format/README.md`](docs/package-format/README.md) |
| Architecture map | [`docs/architecture/README.md`](docs/architecture/README.md) |
| The generated `lore` command line reference | [`docs/cli-reference.md`](docs/cli-reference.md) |
| Worked examples | [`examples/README.md`](examples/README.md) |
| How a build is produced, and why the stage order matters | [`docs/architecture/build-orchestration.md`](docs/architecture/build-orchestration.md) |
| What belongs in a build, and what does not | [`docs/architecture/discovery.md`](docs/architecture/discovery.md) |
| How each format is read, and what is deliberately dropped | [`docs/architecture/parsers.md`](docs/architecture/parsers.md) |
| Every security surface, and the test that holds it | [`docs/architecture/security.md`](docs/architecture/security.md) |
| How a build is deployed, and which rules the orchestration enforces | [`docs/architecture/deployment.md`](docs/architecture/deployment.md) |
| How a model reaches a build, over MCP and HTTP | [`docs/architecture/serving.md`](docs/architecture/serving.md) |
| Studio: behaviour, the manual passes, and the design direction | [`docs/architecture/studio.md`](docs/architecture/studio.md) |
| How typed tables are stored, named and queried | [`docs/architecture/local-storage.md`](docs/architecture/local-storage.md) |
| A tour of Studio, one screenshot per route | [`docs/studio-tour.md`](docs/studio-tour.md) |
| Why each dependency is here, with the checks it passed | [`docs/architecture/dependencies.md`](docs/architecture/dependencies.md) |
| Connecting Claude Code | [`docs/integrations/claude-code.md`](docs/integrations/claude-code.md) |
| Connecting Codex | [`docs/integrations/codex.md`](docs/integrations/codex.md) |
| Connecting VS Code | [`docs/integrations/vscode.md`](docs/integrations/vscode.md) |
| Generic MCP clients | [`docs/integrations/mcp.md`](docs/integrations/mcp.md) |

## Licence

[Apache-2.0](LICENSE).
