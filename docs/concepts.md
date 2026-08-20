# Core concepts

Lorepack is a context build system for AI. It exists for teams that need the context an AI
uses to be inspectable, repeatable and reversible.

If a model answers from project knowledge, the team should be able to ask what knowledge it
used, where that knowledge came from, which version was active and how to roll back a bad
update. Lorepack makes those questions concrete by compiling source artifacts into immutable
builds.

## The short version

Lorepack does four things:

1. **Builds context** from documents, spreadsheets and project artifacts.
2. **Versions context** with a deterministic build id.
3. **Serves context** to AI clients through read-only MCP, HTTP and bounded exports.
4. **Operates context** with plan, inspect, activate, diff, deploy and rollback commands.

The build is the source of truth. Everything else is a projection of that build.

## A practical example

Imagine a team has these files:

- `runbooks/payments.md`
- `requirements/checkout.docx`
- `support/escalations.xlsx`
- `adr/context-boundary.md`

A normal search tool can retrieve passages from those files. Lorepack first compiles them into
a sealed build:

```text
source files -> canonical discovery -> parse -> index -> validate -> sealed build
```

After that:

- Studio can show what was parsed, excluded and activated.
- `lore diff` can show what changed between builds.
- `lore rollback` can point the project back to a previous build.
- An MCP client can ask for task context without reading source files directly.
- A Cloudflare runtime can serve the same build that was inspected locally.

The source folder can keep changing. The active runtime still serves the active build until a
new validated build is activated.

## What problem it solves

Lorepack solves context lifecycle control.

The core problem is not only "can a model find a paragraph?" The harder problem is "can we
treat AI context as a versioned artifact with provenance and operational safety?"

That requires:

- deterministic build identity;
- immutable builds;
- explicit activation;
- rollback without recompilation;
- source locators on every result;
- preservation of structure, especially tables and headings;
- declared precedence rules rather than invented truth;
- read-only model-facing tools.

Those are product invariants, not implementation preferences.

## What Lorepack is not

Lorepack is not a hosted knowledge base, a generic crawler, a multi-tenant control plane, or a
vector database in disguise.

For v0.1, it is also not:

- OCR or screenshot understanding;
- PPTX parsing;
- SaaS connectors for Drive, Notion, Slack or GitHub;
- semantic embeddings in the default install;
- automatic conflict detection;
- LLM-generated summaries as build content;
- server-side compilation on Cloudflare.

Those deferrals are deliberate. v0.1 protects the build model first.

## Comparison with adjacent tools

| Category | Primary question it answers | Where it stops | Lorepack boundary |
|---|---|---|---|
| RAG server | "Which chunks match this query right now?" | Usually treats indexing and retrieval as the product. | Retrieval reads from an immutable build. The lifecycle around that build is the product. |
| MCP document tool | "Can my AI client call a search or read function?" | Usually exposes runtime tools over a mutable source or index. | MCP is read-only and has no build, deploy, edit or shell capability. |
| Vector database | "Which vectors are nearest?" | Does not define source parsing, provenance, activation or rollback. | Semantic search can be a projection later. The build remains canonical. |
| Folder indexer | "Can I keep a local index fresh?" | Freshness does not prove reproducibility or safe activation. | Source files are inputs. The active serving database is a sealed build. |

These tools can be useful. Lorepack is focused on the missing lifecycle around AI context.

## The build lifecycle

Lorepack's lifecycle is:

```text
plan -> build -> validate -> activate -> inspect -> diff -> deploy -> rollback
```

Important details:

- `plan` explains what would be included, excluded or reused.
- `build` writes a candidate build outside the active build set.
- `validate` must pass before activation.
- `activate` changes a pointer.
- `rollback` changes the pointer back to an existing build.
- `deploy` projects an already-built local artifact to a target. It does not compile remotely.

That is why a failed build or failed deploy cannot corrupt the active build.

## Provenance and structure

Every model-facing result must carry a source locator. Depending on the artifact, a locator can
name a file, heading path, line range, page, sheet, table, row or cell range.

This matters because "the model found something" is not enough. A person has to be able to
open the source and verify it.

Structure matters for the same reason. A spreadsheet is not flattened into prose. Lorepack
preserves table shape and exposes a bounded read-only SQL surface for typed tables.

## Technical reader path

Start with these:

- [CLI reference](cli-reference.md) for every command and option.
- [Architecture map](architecture/README.md) for package boundaries and system planes.
- [Build orchestration](architecture/build-orchestration.md) for the compiler lifecycle.
- [Build identity](architecture/build-identity.md) for deterministic ids.
- [Serving](architecture/serving.md) for MCP, HTTP and read-only runtime rules.
- [Retrieval](architecture/retrieval.md) for ranking and context packing.
- [Package format](package-format/README.md) for the sealed artifact layout.
- [Security surfaces](architecture/security.md) for the checked threat boundaries.

## User path

Start with the two-command lifecycle:

```bash
lore dev ./project-context
lore connect claude-code
```

Then use:

- [README](../README.md) for the quick start and limits.
- [Studio tour](studio-tour.md) for visual inspection.
- [Claude Code](integrations/claude-code.md), [Codex](integrations/codex.md), or
  [VS Code](integrations/vscode.md) for client setup.
- [Compatibility](compatibility/README.md) for platform and integration status.

## Contributor path

Start with:

- [Contributor guide](../CONTRIBUTING.md).
- [Agent rules](../AGENTS.md).
- [Testing strategy](architecture/testing.md).
- [Dependency policy](architecture/dependencies.md).
- [Phase gates](architecture/phase-gates.md).

The practical rule is simple: a feature that improves search while weakening deterministic
builds, immutability, provenance or rollback is not aligned with Lorepack.
