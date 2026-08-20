# Lorepack docs

Start here, then take the path that matches the job. The README is the public front door.
This directory holds the institutional-grade details: command references, architecture notes,
integration guides, compatibility evidence, package format and release checks.

## Reader paths

| Reader | Start with | Then use |
|---|---|
| Evaluator | [`../README.md`](../README.md) | [`concepts.md`](concepts.md), [`studio-tour.md`](studio-tour.md), [`demo-transcript.md`](demo-transcript.md) |
| User | [`../README.md#try-the-lifecycle`](../README.md#try-the-lifecycle) | [`integrations/`](integrations/), [`compatibility/README.md`](compatibility/README.md) |
| Technical operator | [`cli-reference.md`](cli-reference.md) | [`package-format/README.md`](package-format/README.md), [`release-checklist.md`](release-checklist.md) |
| Integrator | [`integrations/mcp.md`](integrations/mcp.md) | [`architecture/serving.md`](architecture/serving.md), [`architecture/deployment.md`](architecture/deployment.md) |
| Contributor | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | [`architecture/README.md`](architecture/README.md), [`architecture/testing.md`](architecture/testing.md), [`../AGENTS.md`](../AGENTS.md) |

## What lives where

| Need | Document |
|---|---|
| What Lorepack is, why it exists and how it differs from RAG, MCP wrappers and vector databases | [`concepts.md`](concepts.md) |
| The two-command quick start and honest v0.1 limits | [`../README.md`](../README.md) |
| Every command and option | [`cli-reference.md`](cli-reference.md) |
| Architecture map and package boundaries | [`architecture/README.md`](architecture/README.md) |
| Build lifecycle and deterministic identity | [`architecture/build-orchestration.md`](architecture/build-orchestration.md), [`architecture/build-identity.md`](architecture/build-identity.md) |
| Runtime, MCP and HTTP serving | [`architecture/serving.md`](architecture/serving.md), [`integrations/mcp.md`](integrations/mcp.md) |
| Retrieval and context packing | [`architecture/retrieval.md`](architecture/retrieval.md) |
| Package format and schemas | [`package-format/README.md`](package-format/README.md) |
| Supported platforms, integrations and performance evidence | [`compatibility/README.md`](compatibility/README.md), [`compatibility/performance-v0.1.md`](compatibility/performance-v0.1.md) |
| Security and threat boundaries | [`architecture/security.md`](architecture/security.md), [`architecture/threat-model.md`](architecture/threat-model.md) |

Generated and checked docs:

- [`testing/acceptance.md`](testing/acceptance.md) is generated from the acceptance scenarios.
- [`cli-reference.md`](cli-reference.md) is generated from the CLI command definitions.
- [`images/`](images/) contains generated pictures captured from real CLI and Studio output,
  plus small hand-maintained SVG diagrams for the lifecycle and architecture boundary.

## The pictures are generated, not pasted

`scripts/capture-docs.mjs` builds a demo project, runs the real commands, starts a real
`lore dev`, and photographs Studio in the browser. The CLI and Studio screenshots under
`docs/images/` are regenerated from the product rather than taken by hand. The conceptual SVG
diagrams in the same folder are maintained as text.

```bash
pnpm exec playwright install chromium   # once
pnpm docs:capture
```

This is not tidiness. A screenshot nobody can regenerate is wrong on the first interface edit
and stays wrong, and by then deleting it is easier than retaking it. Making it cheap to retake
is what keeps the documentation honest.

Terminal output is rendered to SVG rather than recorded as a GIF, for two reasons. A GIF needs
a recorder and an encoder, which is a toolchain this project does not have and invariant 7
does not want. And an SVG of real captured bytes stays legible at any size and diffs as text,
so a review can see what the output actually became.
