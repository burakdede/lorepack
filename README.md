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

## Status

**Pre-v0.1. Under active construction, not yet installable.**

The architecture is complete and the work is fully planned. Nothing here is released yet;
`lore` does not exist as a published package. Follow along in the
[backlog](https://github.com/users/burakdede/projects/8).

What v0.1 will deliver:

```bash
lore dev ./project-context     # discover, build, serve, watch
lore connect claude-code       # configure an AI client, safely and verifiably
lore plan && lore build        # see the change, then make it
lore diff && lore rollback     # compare versions, revert instantly
lore deploy cloudflare         # project the same build to a remote runtime
```

## Requirements

Node.js `>=24.15 <25`, and that is the whole list. No Python, Docker, compiler toolchain,
native add-on, model download, API key or account.

The floor is 24.15 because that is the first release where `node:sqlite` exposes the
authorizer and per-connection limits the read-only SQL surface depends on. Lorepack also
needs SQLite compiled with FTS5, which every official Node build has; see
[SQLite FTS5 availability](docs/compatibility/sqlite-fts5.md) for the verified matrix and
what happens if yours does not.

## Design commitments

- **The build is the source of truth.** Every runtime is a projection of an immutable build.
- **Deterministic.** Identical inputs produce an identical build ID on every OS.
- **Provenance always.** Every result traces to a file, section, page, sheet or cell range.
- **No surprises on first run.** No Python, Docker, compiler toolchain, native add-on,
  model download, API key or account.
- **Never invents truth.** Precedence between sources is declared by you, never guessed.

## Documentation

| | |
|---|---|
| Working agreement for contributors and agents | [`AGENTS.md`](AGENTS.md) |
| Full architecture specification | [`Lorepack_Local_First_MVP_Architecture_Final.md`](Lorepack_Local_First_MVP_Architecture_Final.md) |
| How to contribute | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Reporting a vulnerability | [`SECURITY.md`](SECURITY.md) |
| How a build is produced, and why the stage order matters | [`docs/architecture/build-orchestration.md`](docs/architecture/build-orchestration.md) |
| How a model reaches a build, over MCP and HTTP | [`docs/architecture/serving.md`](docs/architecture/serving.md) |

Deeper documentation lands under `docs/` as the implementation progresses.

## Licence

[Apache-2.0](LICENSE).
