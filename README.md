# Lorepack

**Turn your project's documents and spreadsheets into a versioned context build that AI agents
read over MCP, with a citation on every answer.**

Point Lorepack at a folder of runbooks, specs, spreadsheets and PDFs. It compiles them into an
immutable build that Claude Code, Codex, VS Code or any MCP client can search and query, and
every result names the file and lines it came from. Think Git for the context your AI depends
on: see exactly what it reads, diff two versions, and roll back a bad update without
rebuilding.

> **Status:** the `next` npm channel contains the first alpha. Stable v0.1 is not released yet.
> Progress is tracked on the [backlog](https://github.com/users/burakdede/projects/8).

## Install

Requires Node.js 24.15 or later.

For the alpha release:

```bash
npm install -g @lorepack/cli@next
```

The source install remains useful for contributors and for testing unreleased changes:

```bash
git clone https://github.com/burakdede/lorepack.git && cd lorepack
corepack enable && pnpm install --frozen-lockfile && pnpm build
alias lorepack="node $PWD/packages/cli/dist/public-entry.js"
```

The stable install will be `npm install -g @lorepack/cli` after v0.1. See
[Getting started](docs/getting-started.md#install) for details and alpha limitations.

## Use it

```bash
lorepack dev ./my-docs          # build the folder, serve it over MCP and HTTP, rebuild on change
lorepack connect claude-code    # or codex, or vscode: wire up your agent and check it answers
```

![Lorepack CLI demo: build a folder, search it with citations, diff two builds, roll back, and serve it over MCP](docs/images/demo.gif)

[View the static, reduced-motion version of the demo](docs/images/demo.svg).

## What you get

- **Answers with provenance.** Every result names its file, heading path and lines.
  [How provenance works](docs/concepts.md#provenance-and-structure).
- **Spreadsheets stay tables.** CSV and XLSX become typed tables an agent queries with
  read-only SQL, never flattened into prose. [How tables are stored](docs/architecture/local-storage.md).
- **Versioned context.** Builds are immutable and content-addressed: diff any two, activate
  one, roll back without recompiling. [The build lifecycle](docs/concepts.md#the-build-lifecycle).
- **Studio, a local inspector.** See what was indexed and what was left out, what a model
  would receive for a task, and copy any request as a CLI, `curl` or MCP call.
  [Take the tour](docs/studio-tour.md).
- **Nothing else to install.** No Python, Docker, model download, API key or account.
  [Requirements](docs/getting-started.md#requirements).
- **Deploy when ready.** Project the same build to Cloudflare, verified before it goes live.
  [Deployment](docs/architecture/deployment.md).

![Lore Studio, showing the active build, next steps, and the MCP endpoint to give an agent](docs/images/studio-overview.png)

## Learn more

- [Getting started](docs/getting-started.md): install, the first build, and the full lifecycle
- [Core concepts](docs/concepts.md): why the build is the product, and how Lorepack differs
  from RAG servers and vector databases
- Connecting a client: [Claude Code](docs/integrations/claude-code.md),
  [Codex](docs/integrations/codex.md), [VS Code](docs/integrations/vscode.md), or
  [any MCP client](docs/integrations/mcp.md)
- [CLI reference](docs/cli-reference.md)
- [Limitations](docs/limitations.md): what v0.1 does not do
- [All documentation](docs/README.md)

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Agents and contributors work to
[AGENTS.md](AGENTS.md), and vulnerabilities go through [SECURITY.md](SECURITY.md).

## Licence

[Apache-2.0](LICENSE).
