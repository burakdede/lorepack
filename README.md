# Lorepack

**A versioned context build system for AI.**

Lorepack compiles documents, spreadsheets and project files into an immutable build that
AI clients can read through MCP, HTTP or a bounded export. Inspect what went in, review
changes between versions, activate a known build and roll back without rebuilding.

[Where it fits](#where-lorepack-fits) · [Quick start](#quick-start) · [CLI](#lorepack-cli) · [Studio](#lorepack-studio) · [Limits](#supported-inputs-and-limits) · [Documentation](#dive-deeper)

## Where Lorepack fits

Use Lorepack when the context your AI depends on changes, and you need to control which
version it reads.

- **Coding agents:** share one context build across Claude Code, Codex, VS Code or another MCP client.
- **Teams:** review specifications, runbooks, policies and research before activating an update.
- **Documents and spreadsheets:** preserve document structure and query typed tables with source coordinates.
- **CI and deployment:** validate and package a reproducible context artifact, with optional Cloudflare deployment.

The build is the source of truth. Search and task context read that build and carry source
locators. Model-facing tools are read-only; developers control builds, activation and deployment
through the CLI or Studio. Lorepack does not decide which document is true.

[Core concepts](docs/concepts.md) · [Worked examples](examples/README.md)

## Quick start

[Installation and first build](docs/getting-started.md) · [Install from source](docs/getting-started.md#install)

Requires Node.js `>=24.19.0 <25`. Install the alpha from npm's `next` channel and open a
folder of documents:

```bash
npm install -g @lorepack/cli@next
lorepack dev ./my-docs
```

`dev` builds the folder, watches for changes, opens Studio and prints the HTTP and MCP
endpoints. Reads continue from the active build during rebuilds.
No Python, Docker, native add-on, model download, API key or account is required.

Connect an installed AI client:

```bash
lorepack connect claude-code
```

The command previews its configuration change and asks before writing it. [Verification](docs/testing/connect_verification.md)
checks the intended build and a cited source read; the client's own trust prompt is separate.

[Claude Code](docs/integrations/claude-code.md) · [Codex](docs/integrations/codex.md) · [VS Code](docs/integrations/vscode.md) · [Other MCP clients](docs/integrations/mcp.md)

## Lorepack CLI

[Command reference](docs/cli-reference.md) · [Complete walkthrough](docs/getting-started.md#the-lifecycle) · [Real demo output](docs/demo-transcript.md)

![Lorepack CLI: build context, search with citations, compare versions and roll back](docs/images/demo.gif)

[Static, reduced-motion demo](docs/images/demo.svg)

### Build and review an update

In an existing project, compile a candidate while keeping the current build active:

```bash
lorepack plan
lorepack build --no-activate
lorepack validate
lorepack diff <active-build-id> <candidate-build-id>
lorepack activate <candidate-build-id>
lorepack mcp --follow-active
```

Use the full build IDs printed by the commands. `build` activates on success unless you
pass `--no-activate`. `lorepack rollback` selects the previously active build without
recompiling sources.
`mcp --follow-active` serves the reviewed active build and reports source freshness without
rebuilding it. See [MCP serving modes](docs/integrations/mcp.md) for other startup policies.

### Find evidence for a task

```bash
lorepack search "deployment rollback"
lorepack export --task "Prepare a cited rollback checklist"
```

Search returns source excerpts. Task exports assemble bounded context with provenance,
[cited table schema references](docs/architecture/table_context.md) and explicit omissions.
Table rows stay behind separate query reads. Exports do not call a model or generate summaries.

### Inspect, serve and share

| Task | Command |
|---|---|
| [Inspect sources and warnings](docs/architecture/discovery.md) | `lorepack inspect sources`, `lorepack inspect warnings` |
| [Serve an existing build](docs/integrations/mcp.md) | `lorepack serve`, `lorepack mcp --active-only` |
| [Create a portable build](docs/package-format/README.md) | `lorepack pack --out context.lorepack` |
| [Deploy to Cloudflare](docs/integrations/cloudflare-target-setup.md) | `lorepack deploy cloudflare` |

Use `--json` for scripts and CI. The [CLI reference](docs/cli-reference.md) covers every
command, option and shell-completion setup.

## Lorepack Studio

[Studio tour and workflow recordings](docs/studio-tour.md)

Run `lorepack dev ./my-docs` to open the local inspector.

![Lorepack Studio: active build, source freshness, next steps and agent endpoints](docs/images/studio-overview.png)

- **Overview and Sources:** see the active build, freshness, indexed files, exclusions and warnings.
- **Playground:** assemble task context and inspect selections, omissions and equivalent CLI, HTTP and MCP requests.
- **Tables:** inspect schemas and sample rows, then run bounded read-only queries.
- **Versions:** compare builds, activate, roll back and package a retained version.
- **Diagnostics:** check the environment, watcher and detected AI clients.

Studio exposes the same build lifecycle as the CLI. Use the tour for route-by-route
screenshots and detailed workflows.

## Supported inputs and limits

[Format guide](docs/architecture/parsers.md) · [Parser budgets](docs/architecture/parsers.md#built-in-parser-resource-controls) · [CSV limits](docs/architecture/parsers.md#limits) · [v0.1 limitations](docs/limitations.md) · [Compatibility and measurements](docs/compatibility/README.md)

Markdown, plain text, source code, HTML, DOCX, text-layer PDF, CSV and XLSX are supported.
Lorepack preserves the structure each parser exposes and reports unsupported or excluded
content. Spreadsheet formulas are retained as text and never executed.
[Formula and conversion evidence](docs/architecture/table_evidence.md) distinguishes saved
values from unevaluated formulas.

v0.1 does not include OCR, image understanding, PPTX, SaaS connectors, multi-user tenancy
or embeddings in the default install. Retrieval is lexical; authority and precedence are
user-declared hints. Review the limitations before choosing a production integration.

## Dive deeper

[Documentation index](docs/README.md) · [Architecture map](docs/architecture/README.md)

| Topic | Read next |
|---|---|
| Build lifecycle | [Build orchestration](docs/architecture/build-orchestration.md), [validation](docs/validation.md), [watch behavior](docs/architecture/watch.md) |
| Reproducibility | [Build identity](docs/architecture/build-identity.md), [package format](docs/package-format/README.md) |
| Context and tables | [Ranking and delivery limits](docs/architecture/retrieval.md), [table storage](docs/architecture/local-storage.md), [receipts](docs/architecture/context_receipts.md) |
| Runtime access | [MCP](docs/integrations/mcp.md), [HTTP](docs/architecture/serving.md#the-http-surface), [SDK](packages/sdk/README.md), [reader lifetimes](docs/architecture/local-storage.md#request-scoped-build-handles) |
| Deployment | [Cloudflare setup](docs/integrations/cloudflare-target-setup.md), [deployment and cleanup](docs/architecture/deployment.md) |
| Evidence and performance | [Benchmark methodology](benchmarks/README.md), [compatibility evidence](docs/compatibility/README.md) |

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
[Source installation](docs/getting-started.md#install), [testing and CI](docs/architecture/ci.md), including [policy fixtures](docs/architecture/ci.md#keep-release-policy-setup-inside-its-hook)
and [dependency decisions](docs/architecture/dependencies.md) live in the contributor docs.
Cloudflare CI requires credentials; see the [integration test setup](docs/integrations/cloudflare-testing.md#required-environment).

For environment issues, include `lorepack doctor --json`, your OS and Node version.
Report vulnerabilities through [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
