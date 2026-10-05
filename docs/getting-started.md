# Getting started

From nothing to an AI client answering from your documents, with a citation on every answer.

## Requirements

Node.js `>=24.15 <25`, and that is the whole list. No Python, Docker, compiler toolchain,
native add-on, model download, API key or account. The clean-install CI matrix proves it on
macOS, Linux and Windows, installing with lifecycle scripts suppressed and then running the
product.

The floor is 24.15 because that is the first release where `node:sqlite` exposes the authorizer
and per-connection limits the read-only SQL surface depends on. Lorepack also needs SQLite
compiled with FTS5, which every official Node build has. See
[SQLite FTS5 availability](compatibility/sqlite-fts5.md) for the verified matrix, and for what
happens if your build lacks it.

## Install

Lorepack is not on npm yet, so today you install it from source. Building from source also
needs pnpm, which [Corepack](https://nodejs.org/api/corepack.html) ships with Node:

```bash
git clone https://github.com/burakdede/lorepack.git
cd lorepack
corepack enable
pnpm install --frozen-lockfile
pnpm build
alias lore="node $PWD/packages/cli/dist/entry.js"
```

The alias lasts for the current shell. Add it to your shell profile to keep it, or call
`node packages/cli/dist/entry.js` directly.

Once v0.1 is released, the install is one command:

```bash
npm install -g @lorepack/cli
```

## Two commands

```bash
lore dev ./my-docs          # build the folder, serve it with Studio, rebuild on change
lore connect claude-code    # wire an AI client to the build, and prove it answers
```

`lore dev` prints everything you need: the active build, the Studio URL, the HTTP and MCP
endpoints, and a `lore connect` line for each AI client it finds on your machine. Clients with
their own guides:

- [Claude Code](integrations/claude-code.md)
- [Codex](integrations/codex.md)
- [VS Code](integrations/vscode.md)
- [Any MCP client](integrations/mcp.md)

To try it without your own documents, point it at a checked-in example:

```bash
lore dev ./examples/product-research
```

## The lifecycle

Lorepack treats context the way release tooling treats code, so the useful commands come in four
families:

| Step | What happens | Commands |
|---|---|---|
| Start | Preview, build and activate an immutable version | `lore plan`, `lore build` |
| Change | Edit a source and see exactly what will rebuild | `lore plan` |
| Recover | Compare builds, and move the active pointer back without recompiling | `lore diff`, `lore rollback` |
| Deploy | Produce and verify a portable artifact, then project it remotely | `lore pack`, `lore target add cloudflare`, `lore deploy cloudflare` |

`pnpm demo:readme` runs that whole sequence against copies of the checked-in examples and
rewrites [`demo-transcript.md`](demo-transcript.md) with the real output. CI runs
`pnpm demo:readme:check`, so the transcript cannot drift from the product.

Every option of every command is in the [CLI reference](cli-reference.md).

## What the commands show

A build reports what it compiled:

![lore init and lore build](images/cli-build.svg)

Everything the build decided can be inspected without running it again, including the decisions
that removed a file:

![lore status and lore inspect exclusions](images/cli-inspect.svg)

Every result carries the file, the heading path and the lines it came from. A result without
them is a bug, not a style issue:

![lore search, with provenance on every hit](images/cli-search.svg)

## Next

- [Studio tour](studio-tour.md): the local inspector `lore dev` serves.
- [Core concepts](concepts.md): why the build, not the search index, is the product.
- [Limitations](limitations.md): what v0.1 does not do.
