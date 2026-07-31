# Lorepack
## Local-First MVP Architecture and Open-Source Project Specification

**Status:** Final audited architecture  
**Target release:** Lorepack v0.1  
**Working codename:** Lorepack  
**Primary CLI:** `lore`  
**Date:** 30 July 2026

> **Product statement:** Lorepack is a versioned context build system for AI. It compiles a directory of documents, spreadsheets, data, and project artifacts into an immutable build that can be inspected, diffed, deployed, activated, and rolled back, then accessed by chat models and agents through MCP, HTTP, or a bounded export.

---

## 1. Executive decision and market wedge

### 1.1 The product to build

Build **Lorepack** as a local-first, Apache-2.0 developer tool with this primary mental model:

> **Git and Terraform for the context that AI systems depend on.**

The product is not differentiated by indexing documents or exposing search through MCP. Several active open-source tools already provide local document parsing, file watching, BM25 or FTS5 retrieval, embeddings, reranking, and MCP integration.[12][13][14]

Lorepack's wedge is the complete lifecycle around context:

```text
source artifacts
  -> plan
  -> deterministic build
  -> immutable version
  -> validate
  -> project to a runtime
  -> activate atomically
  -> diff or roll back
```

Search and retrieval are required capabilities, but they are **table stakes**. The product identity is the build system.

### 1.2 Architectural invariant

The central invariant is:

> **A Lore build is the source of truth. Every local or remote runtime is a projection of that immutable build.**

This means:

- source files are never the live serving database;
- a mutable vector index is never the canonical state;
- local and Cloudflare deployments receive the same logical build;
- activation is a pointer change after verification;
- a failed build or deployment cannot corrupt the previously active version;
- rollback does not require recompilation.

### 1.3 MVP product decisions

| Area | Final MVP decision |
|---|---|
| First-run experience | No account, API key, Docker daemon, model download, Python runtime, C/C++ compiler, or native npm add-on. |
| Default retrieval | Structure-aware lexical retrieval plus metadata, hierarchy, explicit source authority, provenance, and typed table access. |
| Semantic retrieval | Explicit post-v0.1 enhancement unless lifecycle validation shows it is required earlier; never part of the default install or first-run critical path. |
| Local data | SQLite through Node's bundled `node:sqlite`, isolated behind an adapter, with an FTS5 capability check. |
| AI interfaces | MCP stdio, MCP Streamable HTTP, REST, and bounded Markdown/JSON exports. |
| Client setup | `lore connect` detects supported clients, shows a plan, maps the current workspace to each client's safest documented scope, and verifies both the Lore server and the client registration. |
| Build command | `lore build` hides compile, validate, index, and package stages behind one user-facing operation. |
| Deployment | Backend projections are build-scoped; candidate verification precedes one atomic active-build switch. |
| First remote target | Cloudflare Worker + D1 + R2. Vectorize is a post-v0.1 extension gated by exact embedding compatibility and query-visibility verification. |
| Platform support | macOS, Windows, and Linux are explicit v0.1 targets with cross-platform CI. |

### 1.4 Feedback audit incorporated into this version

| Feedback | Audit result | Design response |
|---|---|---|
| Local MCP document search is crowded | Confirmed by current open-source implementations.[12][13][14] | Versioning, plans, deployment, activation, and rollback now lead the specification and product narrative. |
| Screenshots were promised but OCR was excluded | Valid mismatch | Screenshots and scanned documents are removed from the v0.1 promise and listed as a future parser class. |
| Native SQLite and ONNX dependencies threaten DX | Confirmed risk; prebuilt gaps can force local compilation.[19] | `better-sqlite3` and ONNX are removed from the default installation. The core uses bundled `node:sqlite`; semantic support is optional. |
| First run must survive offline use | Valid | The default build is entirely deterministic and offline after npm installation. No model download occurs; any future semantic enhancement has explicit progress, resumable cache, checksum verification, offline-only mode, and lexical fallback. |
| Agent configuration should be automatic | Confirmed as practical because major clients expose CLI or workspace configuration surfaces.[3][4][5] | Add `lore connect`, `--dry-run`, a non-global workspace default mapped per client, safe merge, backup, disconnect, protocol verification, and client status verification. |
| Conflict handling lacked a producer | Valid | Automatic conflict detection is removed. Explicit `authority`, `status`, and `supersedes` rules are added. |
| Linear vector scan had no bound | Valid | Semantic search is not a v0.1 gate; a future exact-scan adapter is capped at 25,000 vectors x 384 dimensions, a 50 MiB resident matrix, and a release gate of p95 top-20 scan at 250 ms or less on the reference machine. |
| Windows support was unspecified | Valid | Windows 11 x64 is part of the support matrix and CI, with explicit path and watcher rules. |
| Context export needed a useful default budget | Valid | `chat` exports default to an estimated 24,000 tokens with a complete omission report. |

### 1.5 Additional correctness findings from this audit

| Finding | Why it matters | Final design response |
|---|---|---|
| A long-lived MCP or HTTP process could keep an old SQLite handle after activation | Updating the active pointer is insufficient if connected agents need a restart before seeing the new build. | Add request-scoped build handles. In-flight requests finish on their captured immutable build; the next request opens the new active build without reconnecting the client. |
| A semantic build cannot assume that a remote target can embed queries into the same vector space | Matching dimensions alone does not make vectors compatible. | Cloudflare v0.1 is lexical-only. A future semantic target must match the build's exact embedding profile and pass compatibility fixtures; capability loss is never silent. |
| Vectorize acknowledges durable writes before they become query-visible | Activating immediately after upload can expose an incomplete semantic candidate. | Future Vectorize projection uses build-scoped namespaces, batched writes, visibility polling through the runtime query path, and a timeout that leaves the candidate inactive.[27] |
| Byte-identical SQLite files are not required to prove a logically identical build | Treating physical database bytes as canonical would make the portability promise depend on SQLite file-layout details. | Build identity uses canonical logical hashes. Package-member checksums detect corruption, while the SQLite file remains an immutable runtime projection rather than the source of identity. |

---

## 2. Product problem and contract

### 2.1 Problem

A project or research topic accumulates durable context in human-oriented formats:

- Markdown and text documents;
- PDFs and DOCX files;
- CSV exports and XLSX workbooks;
- source code and configuration;
- research notes, requirements, decisions, and historical versions.

Today's AI workflows repeatedly pay the same tax:

- users upload the same artifacts to separate web chats;
- coding agents scan the same directory again in each session;
- large attachments consume a limited model context window;
- conversation compaction loses exact numbers, exceptions, and decision rationale;
- spreadsheets are flattened into prose instead of queried as typed data;
- different clients use inconsistent or stale snapshots;
- a changed requirement does not automatically invalidate context already indexed elsewhere.

### 2.2 Product promise

Given:

```text
project-context/
  strategy.md
  requirements.docx
  customer-research.pdf
  analytics.csv
  pricing.xlsx
  architecture/
  decisions/
  archive/
```

The zero-config path is:

```bash
lore dev ./project-context
```

Lorepack should:

1. create a minimal project configuration when none exists;
2. discover and parse supported artifacts;
3. build an immutable local version;
4. start a file watcher and local Studio;
5. expose MCP and HTTP interfaces;
6. print the exact command to connect a supported AI client;
7. rebuild only affected artifacts when sources change.

The explicit path remains available:

```bash
lore init ./project-context
lore build
lore connect claude-code
```

When a remote runtime is needed:

```bash
lore deploy cloudflare
```

Lorepack plans the change, creates or reuses a build, projects it to Cloudflare, verifies the candidate, and activates it atomically.

### 2.3 User-visible outcome

The user receives:

- a reproducible build ID;
- a local context runtime independent of any chat session;
- workspace-scoped client integration;
- exact source provenance in every result;
- typed access to spreadsheet data;
- bounded task context rather than whole-directory dumping;
- source and build diffs;
- local and remote rollback.

### 2.4 Product boundary

Lorepack is a:

- context build system;
- deterministic compiler and indexer;
- portable context package format;
- read-only context runtime;
- deployment and lifecycle tool;
- set of AI-native protocol adapters.

Lorepack is not initially a:

- chatbot;
- autonomous agent framework;
- conversation-memory product;
- vector database;
- enterprise search suite;
- document editor;
- source-of-truth knowledge-management application.

---

## 3. Codename and positioning

### 3.1 Codename: Lorepack

"Lore" describes accumulated knowledge around a project or subject. "Pack" communicates a portable, versioned artifact. The name remains a working codename until package-name, repository, domain, and trademark clearance; none of those are assumed by this architecture.

### 3.2 Primary positioning

> **Build, version, and deploy the context your AI depends on.**

### 3.3 Category shorthand

> **Git/Terraform for AI context.**

This shorthand is useful because it conveys:

- declarative source configuration;
- a plan before mutation;
- immutable versions;
- deterministic builds;
- local and remote projections;
- atomic activation;
- rollback.

### 3.4 Technical description

> Lorepack is a local-first, open-source context build system that compiles documents, spreadsheets, data, and project artifacts into an immutable package exposed through MCP, HTTP, and bounded exports.

### 3.5 Terminology

| Term | Meaning |
|---|---|
| **Lore project** | A configured set of artifact sources and deterministic rules. |
| **Artifact** | One discovered source file or logical input. |
| **Node** | A structured unit extracted from an artifact, such as a section, sheet, table, or code region. |
| **Chunk** | A retrieval projection derived from one or more nodes. |
| **Lore build** | An immutable compiled snapshot with a content-derived ID. |
| **Context bundle** | A bounded task-specific selection returned to an AI client. |
| **Projection** | Runtime data derived from a Lore build for a backend. |
| **Candidate build** | A compiled or deployed build not yet active. |
| **Active build** | The verified version currently served by a runtime. |

---

## 4. Design principles

### 4.1 The lifecycle is the product

Every major workflow must reinforce:

```text
plan -> build -> validate -> activate -> diff -> rollback
```

Retrieval quality matters, but Lorepack should never present itself as another local RAG or MCP search server.

### 4.2 Local-first means complete

The open-source local version must support the complete core workflow without a hosted account:

- initialize;
- discover and parse;
- build and validate;
- inspect and search;
- assemble task context;
- query structured tables;
- expose MCP and HTTP;
- connect supported clients;
- export bounded context;
- retain build history;
- diff and roll back.

A future hosted platform sells operational convenience, collaboration, and synchronization, not access to a deliberately crippled core.

### 4.3 Zero-surprise first run

The default installation must not require:

- Python;
- Docker;
- a local compiler toolchain;
- a database server;
- an API key;
- an embedding-model download;
- cloud credentials;
- a background daemon.

No command may appear to hang silently. Long stages emit progress, artifact counts, elapsed time, and recovery instructions.

### 4.4 Structure before models

The compiler first preserves:

- artifact identity and checksum;
- document hierarchy;
- headings and locators;
- sheets, columns, rows, and cell ranges;
- code boundaries;
- explicit status, authority, and supersession;
- provenance.

Models and embeddings are optional indexes over this structure, not the canonical representation.

### 4.5 Explicit authority, never invented truth

Lorepack does not automatically decide which conflicting document is correct in v0.1.

Users may declare deterministic rules:

- `status: active | draft | archived`;
- `authority: 0..100` as a ranking preference;
- `supersedes` relationships.

Without those declarations, Lorepack may return multiple relevant sources, but it must not label them as a detected conflict or silently choose one as truth.

### 4.6 Structured data remains structured

CSV and XLSX inputs become:

- typed tables;
- column metadata;
- row counts and statistics;
- compact retrieval descriptions;
- a constrained read-only SQL surface;
- exact file, sheet, and cell provenance.

Flattening a workbook into a long block of prose is an invalid implementation.

### 4.7 Protocols are adapters

MCP is the primary AI-native interface, but it is not the product. The same runtime capabilities are exposed through:

- MCP stdio;
- MCP Streamable HTTP;
- REST;
- CLI and Markdown/JSON export.

The current MCP specification and stable TypeScript SDK support stdio and Streamable HTTP, including the July 2026 protocol revision.[1][2]

### 4.8 One excellent path before a plugin ecosystem

The codebase uses ports and adapters from day one, but v0.1 does not introduce dynamic plugin discovery, a plugin manifest format, or a marketplace. Built-in adapters are registered explicitly and tested as one coherent product.

### 4.9 Transparent magic

Lorepack should hide operational complexity while preserving inspectability:

- defaults work without configuration;
- `lore config show --effective` reveals every resolved default;
- `lore plan` shows intended mutations;
- `--verbose` exposes stage details;
- build manifests record versions and capabilities;
- Studio explains why context was selected or omitted.

### 4.10 Freshness is checked at the AI boundary

The client configuration generated by Lorepack runs:

```bash
lore mcp --project /absolute/path/to/project --ensure-current
```

Before emitting protocol messages, the server performs an authoritative source reconciliation: it discovers the configured files and streams their contents into the project fingerprint. Existing per-artifact hashes still make parsing, normalization, table import, and indexing incremental; reading bytes to verify freshness does not consume model context. Any check lasting more than 250 ms prints file and byte progress to stderr, while MCP stdout remains untouched.

A dirty project triggers an incremental build, validation, and atomic local activation. If that candidate fails, Lorepack exits without serving stale context and leaves the previous build untouched. Serving a known-stale build requires the explicit `--allow-stale` escape hatch.

Every search, source, table, and context result includes the active build ID and source-state metadata. Freshness is therefore visible to both the user and the consuming agent.

---

## 5. MVP scope and support envelope

### 5.1 In scope

- Local directories and explicit file inputs.
- Markdown, plain text, HTML, text-based PDF, DOCX, CSV, and XLSX.
- Optional source-code text ingestion for common UTF-8 code and configuration files.
- Recursive discovery with `.loreignore`.
- Content hashing and incremental reuse.
- Canonical structured intermediate representation.
- Hierarchy-aware deterministic chunking.
- SQLite catalog and typed table storage.
- SQLite FTS5 lexical retrieval.[8]
- Metadata, path, heading, status, and authority ranking.
- Bounded task-aware context assembly.
- Exact provenance in every response.
- Read-only table description and SQL query tools.
- MCP stdio and Streamable HTTP.
- REST API and TypeScript SDK.
- Markdown and JSON context exports.
- Local React/Vite Studio.
- Immutable build history, plan, diff, activation, and rollback.
- Cloudflare reference deployment.
- Apache-2.0 licensing.

### 5.2 Explicitly out of scope for v0.1

- OCR and scanned-document extraction.
- Screenshot, image, audio, or video understanding.
- PPTX parsing.
- Google Drive, Notion, Slack, SharePoint, GitHub, or other SaaS synchronization.
- Multi-user tenancy and source-permission synchronization.
- Automatic contradiction or truth detection.
- LLM-generated summaries as canonical build content.
- Semantic embeddings in the default installation or release gate.
- Knowledge-graph extraction.
- Conversation and personal memory.
- Agent workflows or autonomous actions.
- Server-side compilation on Cloudflare.
- A proprietary opaque binary format.
- Dynamic third-party plugin loading.

### 5.3 Supported platforms

The v0.1 compatibility contract is:

| Platform | Support target |
|---|---|
| macOS | macOS 14+ on Apple Silicon and Intel where CI capacity is available. |
| Windows | Windows 11 x64 using PowerShell, Command Prompt, or a compatible terminal. |
| Linux | Ubuntu 22.04+ x64; other modern glibc distributions are best effort. |
| Node.js | `>=24.15 <25` (Node 24 LTS), pinned in `engines` and CI.[6][7] |

Unsupported Node versions fail immediately with the detected version and an exact upgrade instruction. Lorepack does not fall through into native compilation.

### 5.4 MVP scale envelope

The first release is designed and tested for one developer or team project, not enterprise-scale search.

| Dimension | Supported v0.1 envelope | Behavior beyond envelope |
|---|---|---|
| Source files | Up to 2,500 | Warn during plan; continue only with `--allow-large-project`. |
| Source bytes | Up to 1 GB total | Warn and show the largest artifacts. |
| Normalized chunks | Up to 50,000 | Supported lexical benchmark envelope. |
| Imported table rows | Up to 500,000 total | Warn; recommend splitting data or a future backend. |
| Columns per table | Up to 100 | Fail that table with an actionable parser message; this also matches D1's current per-table column limit.[25] |
| Single text PDF | Up to 500 pages | Warn before processing larger files. |
| Export budget | 4,000 to 40,000 estimated tokens | Require an explicit override outside the range. |

These are product limits and release gates, not claims that underlying SQLite cannot exceed them.

### 5.5 Performance release gates

On a documented reference machine with 8 modern CPU cores, 16 GB RAM, and local NVMe storage:

- authoritative source fingerprint over the full 1 GB / 2,500-file envelope: p95 below 4 s;
- warm lexical search over 50,000 chunks: p95 below 250 ms;
- `lore_context_for_task` without semantic retrieval: p95 below 1.5 s;
- an incremental rebuild of one changed ten-page text document: below 2 s after the file is stable;
- the CLI emits visible progress at least once per second during long operations;
- cancellation leaves the previously active build intact.

These are benchmark gates to measure before release. They must not be advertised until achieved.

### 5.6 Future semantic adapter envelope

A later optional local semantic package may use a small ONNX embedding model. ONNX Runtime distributes prebuilt Node bindings for major Windows, Linux, and macOS targets, but it remains a native runtime dependency and is therefore excluded from the core installation.[18]

Enabling it is explicit:

```bash
lore enhance semantic
```

The enhancement flow must:

- show the exact package, model, revision, dimensions, download size, and cache path before mutation;
- report downloaded bytes and extraction/indexing progress;
- download into a partial file and resume when the provider supports byte-range requests;
- verify expected size and checksum before activation;
- support `--offline`, which uses only a verified local cache;
- remove or quarantine a corrupt partial download;
- leave the current lexical build fully usable when installation or loading fails.

The first exact cosine implementation must:

- be installed explicitly;
- default to a maximum of 25,000 vectors at 384 dimensions;
- keep the raw resident vector matrix at or below 50 MiB;
- achieve p95 of 250 ms or less for a top-20 exact scan on the documented reference machine, excluding query embedding time;
- refuse an unbounded scan and explain the scalable-backend alternatives;
- fall back to the always-available lexical path when unavailable.

---

## 6. Developer experience contract

### 6.1 Installation

Primary installation:

```bash
npm install -g @lorepack/cli
```

Trial path:

```bash
npx @lorepack/cli dev ./project-context
```

The published core package must have no install script that compiles native code. The clean-install test runs on fresh macOS, Windows, and Linux environments without Python, Xcode command-line tools, Visual Studio Build Tools, or `make`.

### 6.2 Zero-config quick path

```bash
lore dev ./project-context
```

When no `lore.yaml` exists, Lorepack:

1. validates the runtime and SQLite/FTS5 capabilities;
2. inspects the directory without modifying it;
3. writes a minimal `lore.yaml`, `.loreignore`, and `.gitignore` entry atomically;
4. prints the files it created;
5. plans and creates the first build;
6. starts watch mode, Studio, HTTP, and local Streamable HTTP MCP;
7. prints client connection commands.

No interactive question is required for the default path. Prompts appear only when a decision is genuinely ambiguous or destructive.

### 6.3 Explicit project path

```bash
lore init ./project-context
lore plan
lore build
lore dev
```

`lore init` is idempotent. Re-running it shows the proposed changes and never overwrites user configuration without confirmation or `--force`.

### 6.4 Expected first-run output

```text
Lorepack 0.1.0
Project: sarjbot

Discovering     184 files                         done
Parsing         173 documents, 11 tables          done
Indexing        12,418 chunks with FTS5           done
Validating      provenance, rules, table schema   done
Activating      lore_b7f2a9c1d4e8                     done

Build           lore_b7f2a9c1d4e8
Reused          0 artifacts (first build)
Warnings        2 unsupported files; run `lore inspect warnings`
Studio          http://127.0.0.1:43110
HTTP            http://127.0.0.1:43110/v1
MCP HTTP        http://127.0.0.1:43110/mcp
MCP stdio       lore mcp --project "/path/to/project"

Connect now:
  lore connect claude-code
  lore connect codex
  lore connect vscode
```

If a stage exceeds one second, the CLI shows an updating count or progress bar. A spinner without measurable progress is insufficient for parsing or indexing.

### 6.5 Core commands

The normal first-time workflow is deliberately two commands:

```bash
lore dev [path]
lore connect [client|all]
```

The explicit build lifecycle uses four verbs:

```bash
lore plan
lore build
lore deploy [target]
lore rollback [build-id]
```

`lore init [path]` remains available for users who want to configure before starting the runtime. `lore build` deliberately hides the internal compile, index, validate, and package phases. By default it validates and atomically activates the new local build; `--no-activate` leaves a verified candidate for CI, inspection, or packing.

Supporting commands:

| Command | Purpose |
|---|---|
| `lore plan` | Read-only preview of source, build, rule, and deployment changes. |
| `lore connect [client]` | Safely configure and verify one AI client; pass `all` to configure every detected supported client. |
| `lore disconnect [client]` | Remove only Lorepack-owned configuration; pass `all` to remove it from every detected supported client. |
| `lore mcp` | Run the workspace-scoped stdio MCP server; generated client configs add `--ensure-current`. |
| `lore serve` | Serve an active build without watching or rebuilding. |
| `lore status` | Show source dirtiness, active build, warnings, and target state. |
| `lore diff [a] [b]` | Compare artifacts, nodes, rules, tables, and capabilities. |
| `lore inspect [item]` | Inspect parsed structure, provenance, warnings, or a build. |
| `lore search "query"` | Exercise lexical retrieval from the terminal. |
| `lore export --task "..."` | Produce a bounded Markdown or JSON context bundle. |
| `lore pack [build-id]` | Export a portable `.lorepack` archive; not required for normal deploys. |
| `lore activate [build-id]` | Activate a verified local build. |
| `lore rollback [build-id]` | Restore the prior or specified verified build. |
| `lore doctor` | Validate Node, SQLite/FTS5, paths, parsers, watcher, and client setup. |
| `lore config show --effective` | Show the complete resolved configuration and its source. |

### 6.6 Client connection experience

```bash
lore connect claude-code
```

Lorepack uses a conceptual **workspace** scope: the server is available only for the current project and is never made global without an explicit flag. That scope maps to each client's documented model:

| Client | Default mapping | Shared/team option |
|---|---|---|
| Claude Code | Official `local` scope for the current project, stored privately by Claude Code. | `--shared` uses project `.mcp.json`, which the client asks users to trust.[3] |
| Codex | Project `.codex/config.toml` in a trusted project. | The same project file may be committed deliberately.[4] |
| VS Code | Workspace `.vscode/mcp.json`, with an explicit notice that it is shareable source-controlled configuration. | Same file; Lorepack never chooses the user profile silently.[5] |

The command must:

1. detect whether the client and a supported configuration surface are available;
2. detect existing Lorepack configuration and ownership receipts;
3. default to the non-global workspace mapping above;
4. show the exact command or file mutation plan;
5. prefer the client's official CLI when it can express the selected scope safely;
6. otherwise parse and merge the documented workspace configuration format;
7. represent commands as executable plus argument arrays, never shell-concatenated strings;
8. write atomically, preserve unrelated configuration, and create a timestamped backup before direct file edits;
9. spawn `lore mcp --ensure-current` and verify the current MCP protocol with `server/discover` plus `tools/list`; use the SDK's backward-compatibility path for 2025-era clients that still initialize a connection;
10. invoke the client's own list/status command when one exists;
11. print the one remaining approval or workspace-trust step, if the client requires it.

Safety flags:

```bash
lore connect claude-code --dry-run
lore connect codex --scope workspace
lore connect vscode --shared
lore connect all --yes
lore disconnect vscode
```

`--scope user` is explicit and never implied by `all`. Unsupported client versions degrade to a validated copy-paste snippet rather than a speculative configuration edit.

### 6.7 Minimal configuration

The generated `lore.yaml` is intentionally small:

```yaml
version: 1
name: sarjbot

sources:
  - ./project-context
```

Useful deterministic rules are opt-in:

```yaml
version: 1
name: sarjbot

sources:
  - ./project-context

rules:
  - match: "archive/**"
    status: archived

  - match: "requirements/current/**"
    status: active
    authority: 100

  - match: "requirements/v2.docx"
    supersedes:
      - "requirements/v1.docx"

context:
  defaultProfile: chat
```

Everything else has versioned defaults. `lore config show --effective` prints the expanded configuration, including include patterns, parser choices, limits, ports, and context budgets.

### 6.8 Configuration precedence

From lowest to highest priority:

1. versioned product defaults;
2. `lore.yaml`;
3. target-specific local configuration under `.lore/targets/`;
4. environment variables for secrets and CI-only overrides;
5. command-line flags.

`lore config explain <path>` shows the final value and which layer supplied it.

### 6.9 Failure and degradation rules

| Failure | Required behavior |
|---|---|
| Unsupported file discovered | Exclude with a visible warning and exact path; do not silently index garbage. |
| Included supported file fails to parse | Fail the candidate build by default; previous build remains active. |
| Optional semantic adapter unavailable | Continue with lexical retrieval and show the capability difference. |
| Offline machine | Default build succeeds; no network call is attempted. |
| FTS5 capability missing | Fail fast in `doctor`/startup with the detected SQLite version and supported remediation. |
| Client launches against dirty sources | Generated `--ensure-current` performs an incremental build before MCP starts; failure exits without serving stale data or changing the previous active build. |
| Port occupied | Select the next available localhost port, print it, and persist it for the dev session. |
| Watch event storm | Debounce, wait for stable content, hash, and treat duplicate events as no-ops. |
| Ctrl-C during build | Remove the incomplete candidate and leave current activation unchanged. |
| Remote deploy partially fails | Candidate remains inactive; emit a resumable deployment receipt. |

### 6.10 Update flow

After source edits:

```bash
lore status
lore plan
lore build
```

Typical output:

```text
Plan for lore_b7f2a9c1d4e8 -> candidate

Artifacts
  + 2 added
  ~ 1 changed
  - 0 removed
  = 181 reused

Rules
  ~ requirements/v2.docx authority 80 -> 100
  + requirements/v2.docx supersedes requirements/v1.docx

Tables
  ~ pricing.xlsx / operator_prices
    rows 1,982 -> 2,104
    columns + membership_price

Expected work
  parse 3 artifacts
  reuse 181 artifacts
  rebuild 27 chunks
```

`lore build` performs plan -> compile/index -> validate -> local activate by default. `--no-activate` keeps the verified candidate inactive. `lore deploy cloudflare` implicitly builds when sources are dirty, but prints the same plan before remote changes. `--no-build` requires a clean working set.

---

## 7. High-level architecture

```text
Artifact pool
  -> deterministic compiler
  -> immutable Lore build
  -> local activation or backend projection
  -> portable context runtime
  -> MCP / HTTP / export
  -> coding agents, chat models, and custom agents
```

The architecture has four explicit planes.

### 7.1 Build plane

Runs locally in v0.1:

- discover;
- fingerprint;
- parse;
- normalize;
- import typed tables;
- apply deterministic rules;
- chunk;
- create lexical indexes;
- validate;
- write an immutable candidate.

### 7.2 Lifecycle plane

Owns:

- plan;
- build history;
- candidate state;
- validation gates;
- active pointer;
- diff;
- deployment receipts;
- rollback and retention.

This plane is the differentiating product layer.

### 7.3 Runtime plane

Loads one active build through storage interfaces and exposes:

- project/build description;
- lexical search;
- task context assembly;
- source reads;
- table description and safe queries;
- provenance.

### 7.4 Interface plane

Adapts the same runtime capabilities to:

- MCP stdio;
- MCP Streamable HTTP;
- REST;
- CLI;
- Studio;
- Markdown/JSON export.

Cloudflare, MCP, UI, and parser packages must never leak into the domain model.

---

## 8. Recommended technology stack

### 8.1 Language and repository

| Area | Choice | Reason |
|---|---|---|
| Main language | TypeScript | One language across CLI, compiler, local runtime, Cloudflare Worker, SDK, and UI. |
| Runtime | Node.js `>=24.15 <25` | Bundled SQLite release-candidate API and current LTS support.[6][7] |
| Module format | ESM | Aligns with current Node and edge tooling. |
| Monorepo | pnpm workspaces | Native workspace support without an orchestration framework.[10] |
| Formatting/linting | Biome | One fast formatting and static-analysis path. |
| Tests | Vitest | Shared unit/integration runner for TypeScript and Vite code.[11] |
| Releases | Changesets | Package versioning and changelog discipline. |

Do not add Turborepo, Nx, Bazel, or a remote build cache until repository timings demonstrate the need.

### 8.2 CLI

Use:

- `commander` for command definitions;
- `@clack/prompts` only for genuine interactive decisions;
- `zod` for config, manifest, and public input validation;
- `chokidar` for cross-platform watch mode;
- `picocolors` and a small progress renderer;
- `execa` for invoking supported client CLIs and Wrangler;
- `proper-lockfile` or an equivalent narrow lock for build/activation coordination.

Chokidar supports cross-platform watching and options for atomic or chunked writes, but Lorepack must still reconcile with content hashes and a post-ready scan rather than trusting a single event stream.[9]

CLI handlers orchestrate application services. No parser, storage, ranking, or deployment logic belongs in command files.

### 8.3 Local SQLite decision

Use Node's bundled `node:sqlite` API with raw SQL migrations.

Reasons:

- no native npm add-on;
- no `node-gyp` fallback;
- no post-install binary download;
- SQLite ships with the supported Node runtime;
- local schema can remain close to D1's SQLite semantics.

The API is release-candidate stability in the supported Node 24 range, so this is a conscious trade-off, not an assumption.[7]

Mitigations:

- isolate all use behind `CatalogStore` and `TableStore` interfaces;
- pin and test a narrow Node LTS range;
- run a startup capability probe that creates and queries an FTS5 table;
- open completed build databases with `readOnly: true`, `defensive: true`, extension loading disabled, and bounded SQLite runtime limits;
- maintain adapter contract tests;
- avoid depending on experimental session/changeset features;
- retain the option to replace the adapter without changing the build format.

Do not use an ORM in v0.1. Versioned SQL migrations are easier to inspect and share with the D1 projection.

### 8.4 Local database mode

- Candidate build: writable SQLite file in a temporary build directory.
- Completed build: immutable file; runtime opens read-only.
- Dev metadata: a separate small writable database or JSON receipt, never writes into the completed build.
- FTS5: one content-indexed table for chunks with weighted title, path, heading, and body columns.[8]
- Structured tables: namespaced physical tables with a catalog mapping stable Lore table IDs to SQL names.

### 8.5 HTTP runtime

Use **Hono** for portable Web-Standards request/response routing across Node and Cloudflare.[15]

Route handlers depend on `LoreRuntime` capabilities, not on SQLite or Cloudflare bindings.

### 8.6 MCP

Use the official Model Context Protocol TypeScript SDK v2, pinned to a tested minor version. The v2 line implements the 2026-07-28 specification and supports stdio and Streamable HTTP.[1][2]

Keep MCP in one package so protocol changes do not affect the compiler or storage schema.

### 8.7 Parsers

| Format | Library/approach | MVP behavior |
|---|---|---|
| Markdown | `unified` + `remark` | Preserve heading hierarchy, lists, code blocks, links, and source offsets where available. |
| Plain text/code | Native decoding + extension registry | Paragraph or syntax-neutral region splitting; no AST requirement in v0.1. |
| HTML | `unified`/`rehype` | Remove script/style/navigation noise; preserve headings, links, lists, code, and tables. |
| PDF | `pdfjs-dist` | Text-based PDFs only; preserve page locators and emit extraction warnings. |
| DOCX | `mammoth` | Convert semantic document structure to HTML, then normalize. |
| CSV | `csv-parse` | Detect header, infer conservative types, and import as a table. |
| XLSX | `exceljs` | Preserve workbook, sheet, cell range, formulas-as-text, and inferred table regions. |

No Python sidecar is part of the MVP. Advanced layout extraction, OCR, and complex workbooks can later use optional parser adapters.

### 8.8 Studio

Use:

- React;
- Vite;
- React Router;
- TanStack Query;
- a small accessible component set;
- no global state library initially.

Studio is an inspector, planner, and context debugger. It is not a chat application.

### 8.9 Optional semantic package, later

Keep semantic dependencies outside the core dependency graph:

```text
@lorepack/semantic-local
  -> @huggingface/transformers
  -> onnxruntime-node
```

A future command may be:

```bash
lore enhance semantic
```

The download flow must expose byte progress, a resumable partial cache, pinned model revision, expected size/checksum, and local-files-only mode; Transformers.js exposes progress and offline lookup controls.[17] The feature is never imported by the base CLI until explicitly enabled.

---

## 9. Repository layout

Keep one repository with a small number of packages:

```text
lorepack/
  apps/
    studio/                       # React/Vite inspector

  packages/
    core/                         # domain types, rules, plan, build IDs
    compiler/                     # deterministic pipeline and validation
    parsers/                      # built-in format adapters
    backend-local/                # node:sqlite + filesystem implementation
    runtime/                      # portable context capabilities + Hono routes
    mcp/                          # MCP tools/resources and transports
    cli/                          # `lore` executable and DX orchestration
    connect-clients/              # safe client detection/config adapters
    deploy-cloudflare/            # Cloudflare plan/apply/verify/activate
    sdk/                          # small TypeScript HTTP client

  schemas/                        # public JSON Schemas
  migrations/
    local/
    cloudflare/

  fixtures/
    documents/
    spreadsheets/
    paths/
    expected/

  benchmarks/
    retrieval/
    incremental-build/

  examples/
    product-research/
    coding-project/

  docs/
    architecture/
    package-format/
    integrations/
    compatibility/

  pnpm-workspace.yaml
  biome.json
  vitest.workspace.ts
  LICENSE
```

### 9.1 Dependency direction

```text
core <- compiler <- cli
core <- parsers <- compiler
core <- backend-local <- runtime
runtime <- mcp
runtime HTTP <- studio
core/build-format <- deploy-cloudflare
connect-clients <- cli
```

Rules:

- `core` imports no parser, database, MCP, UI, or Cloudflare code.
- `compiler` sees parser and build-store interfaces, not client protocols.
- `parsers` implement contracts declared by `core` or `compiler`.
- `backend-local` implements catalog, table, object, build-store, and active-build-provider ports.
- `runtime` consumes request-scoped read-only build handles.
- `mcp` maps runtime capabilities into protocol schemas.
- `deploy-cloudflare` consumes the portable build format, never compiler internals.
- `studio` communicates only through HTTP APIs.

### 9.2 No package explosion

Do not create one package per parser or storage table. Split only where there is a real runtime, dependency, or licensing boundary. Semantic support is separate because it changes installation weight and native-runtime risk.

---

## 10. Canonical data model

The canonical model is more important than any retrieval index.

### 10.1 Source

```ts
interface Source {
  id: string;
  kind: "directory" | "file";
  root: string;
  include: string[];
  exclude: string[];
  followSymlinks: boolean;
}
```

### 10.2 Artifact

```ts
type ArtifactStatus = "active" | "draft" | "archived";

interface Artifact {
  id: string;                  // normalized source ID + POSIX relative path
  sourceId: string;
  relativePath: string;        // always POSIX-style internally
  displayPath: string;         // native path for user-facing output
  mediaType: string;
  byteSize: number;
  contentHash: string;
  parserId: string;
  parserVersion: string;
  title?: string;
  status: ArtifactStatus;
  authority: number;           // 0..100 ranking hint, not a truth score
  supersedes: string[];        // artifact IDs
  metadata: Record<string, unknown>;
}
```

### 10.3 Node

```ts
type NodeKind =
  | "document"
  | "section"
  | "paragraph"
  | "list"
  | "code"
  | "table"
  | "sheet"
  | "row-group";

interface LoreNode {
  id: string;
  artifactId: string;
  parentId?: string;
  kind: NodeKind;
  ordinal: number;
  title?: string;
  text?: string;
  locator: SourceLocator;
  metadata: Record<string, unknown>;
  revisionHash: string;
}
```

### 10.4 Chunk

A chunk is a retrieval projection, not the primary representation.

```ts
interface Chunk {
  id: string;
  artifactId: string;
  nodeIds: string[];
  headingPath: string[];
  text: string;
  estimatedTokens: number;
  locator: SourceLocator;
  revisionHash: string;
}
```

### 10.5 Table

```ts
interface LoreTable {
  id: string;
  artifactId: string;
  name: string;
  sheet?: string;
  sqlName: string;
  columns: Array<{
    name: string;
    type: "text" | "integer" | "real" | "boolean" | "date" | "unknown";
    nullable: boolean;
  }>;
  rowCount: number;
  locator: SourceLocator;
}
```

### 10.6 Rule resolution

```ts
interface ResolvedArtifactRule {
  artifactId: string;
  status: ArtifactStatus;
  authority: number;
  supersedes: string[];
  matchedRules: string[];
}
```

Validation rejects:

- missing superseded targets;
- supersession cycles;
- authority outside `0..100`;
- case-only path collisions on case-insensitive filesystems;
- rules that match no artifact when `strictRules` is enabled.

### 10.7 Build manifest

```ts
type BuildId = `lore_${string}`; // full lowercase SHA-256 after the prefix

interface EmbeddingProfile {
  modelId: string;
  revision: string;
  tokenizer: string;
  pooling: "mean" | "cls";
  normalized: boolean;
  dimensions: number;
  valueType: "float32";
}

interface LoreBuildManifest {
  formatVersion: 1;
  buildId: BuildId;
  projectName: string;
  compilerVersion: string;
  schemaVersion: number;
  configurationHash: string;
  sourceFingerprint: string;
  canonicalRoots: {
    artifacts: string;
    nodes: string;
    chunks: string;
    tables: string;
    objects: string;
  };
  capabilities: Array<
    | "lexical-search"
    | "structured-context"
    | "table-query"
    | "semantic-search"
  >;
  embeddingProfile?: EmbeddingProfile;
  counts: {
    artifacts: number;
    nodes: number;
    chunks: number;
    tables: number;
    tableRows: number;
  };
  warnings: BuildWarning[];
}
```

### 10.8 Provenance is mandatory

```ts
interface SourceLocator {
  artifactId: string;
  relativePath: string;
  page?: number;
  headingPath?: string[];
  sheet?: string;
  cellRange?: string;
  lineStart?: number;
  lineEnd?: number;
}
```

A search result, table result, or context item without a locator is invalid and fails runtime contract tests.

---

## 11. Build and package format

### 11.1 Project files

```text
lore.yaml                       # user configuration
lore.lock                       # parser/schema/optional model locks
.loreignore                     # exclusions
.lore/
  cache/                        # disposable content-addressed cache
  builds/
    lore_<full-sha256>/
      manifest.json
      context.sqlite
      objects/
      reports/
  state.sqlite                 # mutable active pointer, deployment state, and operational build receipts
  targets/
    cloudflare.json            # local non-secret target receipt
```

Commit:

- `lore.yaml`;
- `lore.lock`;
- `.loreignore`.

Ignore `.lore/` by default. CI may publish `.lorepack` archives as build artifacts.

### 11.2 Build directory contents

```text
lore_<full-sha256>/
  manifest.json
  context.sqlite
  objects/
    sha256/ab/cd/...
  reports/
    warnings.json
    omissions-schema.json
    benchmark-metadata.json
    canonical-hashes.json
```

`context.sqlite` contains normalized metadata, nodes, chunks, FTS5 indexes, table catalog, typed tables, and rule results. Large normalized source bodies may be content-addressed objects referenced from SQLite.

Normalized source text required for remote source reads is included in the build. Original binary files are excluded by default and may be added only through an explicit `package.includeOriginals: true` setting.

### 11.3 Portable archive

```bash
lore pack lore_b7f2a9c1d4e8
```

Produces:

```text
sarjbot-lore_b7f2a9c1d4e8.lorepack
```

A `.lorepack` file is a standard ZIP envelope with:

- stable file ordering;
- normalized timestamps;
- no encrypted or proprietary payload;
- a top-level manifest;
- checksums for every member.

The build ID is derived from canonical logical content, not from incidental ZIP container bytes or the physical byte layout of `context.sqlite`. Member checksums detect package corruption; they are not the cross-platform identity of the build.

### 11.4 Deterministic build ID

The canonical ID is `lore_` followed by the full lowercase SHA-256 digest. Manifests, APIs, receipts, and on-disk build directories store the full ID. Human-facing output displays the shortest unambiguous prefix, with 12 hexadecimal characters as the default; the examples in this document use that display form.

The digest is derived from canonical logical hashes of:

- format and schema versions;
- compiler version where output semantics require it;
- effective configuration excluding secrets and local absolute paths;
- normalized source paths and content hashes;
- parser IDs and versions;
- rule resolution;
- exact optional embedding profile;
- canonical artifact, node, chunk, table, and object roots.

Operational timestamps, machine name, absolute workspace path, temporary directory, deployment target, ZIP metadata, and physical SQLite page layout are excluded.

### 11.5 Lockfile

`lore.lock` records the versions that can affect deterministic output:

```yaml
formatVersion: 1
compiler: 0.1.0
schema: 1
parsers:
  markdown: 0.1.0
  pdf-text: 0.1.0
  docx: 0.1.0
  xlsx: 0.1.0
semantic: null
```

`lore build --frozen` fails if the lockfile would change.

### 11.6 Build states

```text
planned -> building -> validating -> verified -> active
                    \-> failed
verified -> packed
verified -> projected -> remotely_verified -> remotely_active
```

Only verified builds may be activated or deployed.

### 11.7 Operational build receipt

Wall-clock and machine-specific information is kept outside the canonical build and outside `.lorepack` archives:

```ts
interface BuildReceipt {
  buildId: BuildId;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  cache: { reusedArtifacts: number; rebuiltArtifacts: number };
  platform: string;
  nodeVersion: string;
}
```

This separation allows two machines to produce the same build ID, canonical manifest, and logical hash roots without pretending that operational history or physical SQLite bytes are identical.

---

## 12. Compiler pipeline

### 12.1 Pipeline

```text
Discover
  -> Normalize paths
  -> Fingerprint
  -> Parse
  -> Normalize structure
  -> Import tables
  -> Resolve explicit rules
  -> Chunk
  -> Build lexical index
  -> Validate
  -> Seal immutable build
```

Each stage consumes and emits typed records. No stage mutates a previously completed build.

### 12.2 Discover

Rules:

- use `lore.yaml` sources plus `.loreignore`;
- ignore `.git`, `node_modules`, `.lore`, build outputs, and credential-shaped files by default;
- do not follow symlinks unless explicitly enabled;
- reject paths escaping the configured root;
- detect case-insensitive collisions;
- sort normalized POSIX relative paths before processing.

### 12.3 Fingerprint and cache

Cache key:

```text
artifact content hash
+ parser ID/version
+ relevant effective config
+ rule inputs that affect output
```

Explicit `lore build` and `lore mcp --ensure-current` runs discover and content-hash every configured file before declaring the project clean. File metadata is retained for diagnostics and watch-event coalescing, but it is not sufficient proof of freshness.

A running `lore dev` process hashes affected paths immediately and performs a full reconciliation after watcher startup, after watcher recovery, and periodically during long sessions. Watch events are an acceleration mechanism; content hashes are the source of truth.

Unchanged artifacts reuse parsed nodes, chunks, table data, and normalized objects. The new build still receives independent immutable catalog rows.

### 12.4 Parse

Parser output:

```ts
interface ParsedArtifact {
  artifact: Artifact;
  nodes: LoreNode[];
  tables: ParsedTable[];
  normalizedObjects: ObjectReference[];
  warnings: ParserWarning[];
}
```

A parser may emit warnings for recoverable loss, such as malformed PDF text order. A supported included file that cannot be parsed fails the candidate by default.

### 12.5 Normalize

Normalization must be deterministic:

- Unicode normalization policy is versioned;
- line endings become `\n` internally;
- repeated whitespace is normalized only where semantically safe;
- headings and list structure remain explicit;
- code blocks preserve exact text;
- absolute paths never enter canonical IDs;
- normalized source copies retain enough text for remote source reads.

### 12.6 Import tables

For CSV/XLSX:

1. identify sheet or region;
2. detect or synthesize a stable header;
3. infer conservative column types from a bounded sample;
4. import values into a namespaced physical table;
5. store formula text separately where present;
6. calculate row count and lightweight null/distinct summaries;
7. generate a compact retrieval node describing schema and provenance.

Type inference must prefer `text` when values are ambiguous. It must never silently coerce identifiers such as leading-zero postal codes into integers.

### 12.7 Resolve authority and supersession

Apply config rules after discovery and before indexing.

Rules are deterministic and ordered. Later rules may override scalar fields, while `supersedes` lists merge and deduplicate unless `replace: true` is explicit.

Semantics:

- `archived` artifacts are searchable only when requested or when no active source satisfies the query;
- `draft` artifacts receive a ranking penalty and a visible label;
- `authority` is a ranking multiplier, not evidence that content is true;
- a superseded artifact remains readable and diffable but is excluded from default task bundles.

### 12.8 Chunk

Chunking is hierarchy-aware and format-specific:

- preserve heading ancestry;
- prefer whole semantic nodes;
- split only beyond a configurable size;
- include a small parent-heading prefix for retrieval;
- never join unrelated artifacts;
- store exact node IDs and locators;
- estimate tokens conservatively.

Initial defaults:

- target 700 estimated tokens;
- hard maximum 1,200;
- overlap only when a split occurs, maximum 100 estimated tokens.

### 12.9 Build lexical index

FTS5 columns:

```text
chunk_id UNINDEXED
artifact_id UNINDEXED
status UNINDEXED
authority UNINDEXED
path
title
heading
body
```

Ranking combines FTS5 BM25 with deterministic boosts in the runtime. Do not bake mutable ranking weights into the primary text data.

### 12.10 Validate

A candidate cannot be sealed unless:

- every artifact has a stable ID and content hash;
- every node belongs to an artifact;
- every chunk points to existing nodes and provenance;
- every table has a valid catalog mapping;
- FTS row counts match chunk counts;
- rule references and supersession graph are valid;
- object checksums match;
- no secret value from environment/config is present in the manifest;
- a smoke search and source read succeed;
- the database passes `PRAGMA integrity_check` or the supported equivalent.

### 12.11 Watch mode correctness

Watch mode uses Chokidar for event collection but content hashing for truth.

Algorithm:

1. perform initial scan;
2. start watcher;
3. after watcher reports ready, run a reconciliation scan to close the scan/watch race;
4. coalesce path events for a short debounce interval;
5. wait until size and modification time are stable;
6. fingerprint content;
7. ignore duplicate hashes;
8. create a new candidate build;
9. activate only after validation.

On Windows, internal IDs use POSIX separators while filesystem calls use native paths. Rename/save patterns are tested with common editors.

---

## 13. Retrieval and context assembly

### 13.1 Runtime capability boundary

```ts
interface LoreRuntime {
  describeBuild(): Promise<BuildDescription>;
  search(request: SearchRequest): Promise<SearchResult>;
  contextForTask(request: TaskContextRequest): Promise<ContextBundle>;
  readSource(request: SourceReadRequest): Promise<SourceReadResult>;
  listTables(): Promise<LoreTable[]>;
  describeTable(id: string): Promise<TableDescription>;
  queryTable(request: TableQueryRequest): Promise<TableQueryResult>;
}
```

MCP, REST, CLI, and Studio all call this interface.

### 13.2 Default candidate retrieval

The v0.1 retrieval path is deterministic:

1. FTS5 candidate search;
2. exact path/title/heading match boosts;
3. active/draft/archived status adjustment;
4. user-declared authority boost;
5. superseded-source suppression;
6. optional file-type and path filters;
7. parent and adjacent-node expansion;
8. duplicate and near-duplicate removal;
9. artifact diversity;
10. budget-aware packing.

Search results expose score components in debug mode. Lorepack should never imply that a lexical score is a confidence or truth score.

### 13.3 Task-aware context assembly

```ts
interface TaskContextRequest {
  task: string;
  profile?: "agent" | "coding" | "chat" | "deep";
  budget?: number;
  includeArchived?: boolean;
  filters?: ContextFilter[];
}
```

The assembler returns:

```ts
interface ContextBundle {
  buildId: BuildId;
  task: string;
  profile: string;
  estimatedTokens: number;
  overview: ContextItem[];
  selected: ContextItem[];
  tables: TableReference[];
  alternatives: ContextItem[];
  omitted: OmittedItem[];
  citations: Citation[];
}
```

Selection policy:

- reserve a small budget for build/project orientation;
- prioritize active, authoritative, directly matched sources;
- include parent headings and enough adjacent context to preserve meaning;
- include alternative sources when no explicit precedence exists;
- avoid overfilling from one artifact unless the task clearly targets it;
- list every omission category and cut-off reason;
- never generate a synthetic answer inside the core runtime.

### 13.4 No automatic conflict claim

Lorepack may return:

```text
Alternative relevant sources
- requirements/v1.docx [superseded]
- notes/launch-draft.md [draft]
```

It may not return:

```text
Detected conflict: source A contradicts source B
```

unless a future explicit analysis capability actually produced and stored that conclusion.

### 13.5 Context profiles

| Profile | Default estimated token budget | Intended use |
|---|---:|---|
| `agent` | 12,000 | Repeated tool calls where the agent can fetch more. |
| `coding` | 16,000 | Coding harness tasks with source code already in the agent workspace. |
| `chat` | 24,000 | One bounded file or paste for a web chat. |
| `deep` | 40,000 | Deliberate broad review in a large-window client. |

`lore export` defaults to `chat`. `lore_context_for_task` defaults to `agent` unless the client passes a profile.

### 13.6 Token accounting

The core uses a deterministic conservative estimate and labels it as an estimate. The report includes:

- budget requested;
- estimated tokens selected;
- reserved overhead;
- items omitted by budget;
- largest selected items;
- truncation boundaries.

Model-specific tokenizers may be added as optional adapters, but the package format cannot depend on one model vendor.

### 13.7 Read-only table query

The runtime accepts one constrained SQL statement against build-owned tables.

Rules:

- exactly one `SELECT` or `WITH ... SELECT`;
- no comments that hide extra statements;
- no `PRAGMA`, `ATTACH`, `DETACH`, DDL, DML, extension loading, or filesystem functions;
- allowlisted tables only;
- bound row, byte, and execution-time limits;
- default `LIMIT` injection when absent;
- read-only database connection;
- result includes table and source provenance.

A separate `describeTable` tool should be preferred before free-form SQL.

### 13.8 Optional semantic fusion later

When the semantic capability is installed, candidate lists may be fused with Reciprocal Rank Fusion. The runtime contract remains the same and the build manifest records the complete `EmbeddingProfile`, not only model name or dimensions. A query embedder is compatible only when model ID, immutable revision, tokenizer, pooling, normalization, value type, and dimensions match. A build without semantic vectors remains fully valid.

---

## 14. AI-native interfaces and compatibility

### 14.1 MCP tool surface

Keep the surface small to reduce schema/context overhead:

| Tool | Purpose |
|---|---|
| `lore_build_info` | Describe active build, capabilities, counts, warnings, and freshness. |
| `lore_search` | Find relevant passages with filters and provenance. |
| `lore_context_for_task` | Assemble a bounded, task-aware context bundle. |
| `lore_read_source` | Read a precise normalized source range. |
| `lore_list_tables` | Discover available structured datasets. |
| `lore_describe_table` | Read schema, row count, examples, and provenance. |
| `lore_query_table` | Execute constrained read-only SQL. |

Do not expose one MCP tool per document or internal compiler stage.

### 14.2 MCP resources

Useful resources:

```text
lore://project/build
lore://project/sources
lore://project/tables
lore://source/{artifactId}
lore://build/{buildId}/diff/{otherBuildId}
```

Resources are supplemental. Tools remain the most predictable path for task-aware retrieval across clients.

### 14.3 Local stdio

Generated client configurations launch:

```bash
lore mcp --project /absolute/path/to/project --ensure-current
```

Startup sequence:

1. acquire the project build lock;
2. fingerprint configured sources and effective build inputs;
3. reuse the active build when clean;
4. when dirty, perform an incremental build, validation, and atomic activation before protocol output begins;
5. open the active build read-only;
6. expose protocol messages only on stdout and diagnostics only on stderr.

If no verified build exists, or a required rebuild fails, the process exits with an actionable error and leaves the previous active pointer untouched. `--allow-stale` is an explicit recovery option; when used, every tool result carries `sourceState: "dirty"` and a warning. `--active-only` skips source checks for pinned CI or forensic use.

The current protocol verification path uses `server/discover` and `tools/list`. The MCP adapter retains backward compatibility with clients implementing the preceding connection-oriented revision.[1][2][26] List responses use deterministic ordering and the current cache fields; every content result carries its build ID, so content freshness does not depend on a cached capability list.

### 14.4 Streamable HTTP

`lore dev` and `lore serve` expose:

```text
POST /mcp
```

Use the current stateless Streamable HTTP model where possible. Local HTTP binds only to `127.0.0.1` by default and validates request origins. Remote deployment requires authentication.[1][20]

### 14.5 REST API

```text
GET  /v1/build
POST /v1/search
POST /v1/context
GET  /v1/sources/:artifactId
GET  /v1/tables
GET  /v1/tables/:tableId
POST /v1/tables/:tableId/query
GET  /health
```

MCP and REST share Zod contracts generated into JSON Schema and SDK types.

### 14.6 Context export

```bash
lore export \
  --task "Review the pricing strategy and identify unsupported assumptions" \
  --profile chat \
  --format markdown \
  --output pricing-review-context.md
```

Default output budget: **24,000 estimated tokens**.

The file includes:

- project and build ID;
- task and profile;
- selected context grouped by source;
- exact citations;
- relevant table schemas or bounded row samples;
- estimated token usage;
- omitted sources and reasons;
- command to retrieve more.

This is the universal compatibility bridge for chat products that cannot connect to MCP.

### 14.7 Client compatibility matrix

| Client type | Local path | Remote path | Lorepack experience |
|---|---|---|---|
| Claude Code | stdio MCP | Streamable HTTP | `lore connect claude-code` using official CLI/project config.[3] |
| Codex CLI/IDE/ChatGPT desktop configuration | stdio MCP | Streamable HTTP | `lore connect codex`; project `.codex/config.toml` by default.[4] |
| VS Code agent mode | stdio MCP | Streamable HTTP | `lore connect vscode`; workspace `.vscode/mcp.json` by default.[5] |
| Cursor and other MCP clients | client-dependent | client-dependent | Detect known format only when verified; otherwise print a validated copy-paste snippet. |
| Web chat without MCP | not available | not available | `lore export --profile chat`. |
| Custom agent | stdio/HTTP | HTTP | MCP or REST SDK. |

The product must never claim that every web chat can connect directly to a localhost MCP server.

### 14.8 Client configuration adapters

```ts
interface ClientConnector {
  id: string;
  detect(): Promise<ClientDetection>;
  plan(input: ConnectInput): Promise<ConnectPlan>;
  apply(plan: ConnectPlan): Promise<ConnectReceipt>;
  verify(receipt: ConnectReceipt): Promise<ConnectionCheck>;
  remove(receipt: ConnectReceipt): Promise<void>;
}
```

Adapters are versioned and fixture-tested against documented client config shapes. Unsupported versions degrade to a printed configuration snippet rather than risky file mutation.

---

## 15. Local runtime and Studio

### 15.1 Process model

`lore dev` runs one foreground supervisor containing:

- file watcher;
- incremental build coordinator;
- local Hono server;
- Streamable HTTP MCP route;
- Studio static assets;
- active-build generation monitor.

`lore mcp` remains a separate client-managed stdio process. Both resolve the same transactional active-build pointer and open immutable build databases read-only.

No background system service is installed in v0.1.

### 15.2 Live activation without reconnecting clients

```ts
interface ActiveBuildProvider {
  current(): Promise<{ buildId: BuildId; generation: number }>;
  acquire(): Promise<BuildHandle>; // read-only and reference-counted
}
```

At the start of every MCP tool call or HTTP request, the runtime checks the monotonic active-build generation and acquires one immutable build handle. The request uses that handle for its entire lifetime and includes its `buildId` in the result.

Activation semantics:

1. a request already in flight finishes against its captured build;
2. the first request after the pointer transaction observes the new generation and opens the new build;
3. no single response may mix rows from two builds;
4. an old database handle closes only after its final in-flight request releases it;
5. a missed filesystem notification is harmless because the request boundary rechecks the generation in `state.sqlite`.

Connected coding agents therefore see a successful `lore build`, `lore dev` rebuild, or rollback on the next tool call without restarting or reconfiguring the client.

### 15.3 Local ports and files

```text
127.0.0.1:43110     preferred dev port
.lore/dev.json       current dev-session receipt
.lore/state.sqlite   transactional active-build pointer and receipts
```

If the preferred port is occupied, select the next available port and print it. Never bind to all interfaces without an explicit `--host` flag and warning.

### 15.4 Storage ports

```ts
interface BuildStore {
  createCandidate(...): Promise<CandidateBuild>;
  seal(...): Promise<VerifiedBuild>;
  listBuilds(): Promise<BuildSummary[]>;
  activate(buildId: BuildId): Promise<void>;
  current(): Promise<BuildSummary | null>;
}

interface CatalogStore {
  describeBuild(): Promise<BuildDescription>;
  searchLexical(...): Promise<RankedChunk[]>;
  readChunks(...): Promise<Chunk[]>;
  readSource(...): Promise<SourceReadResult>;
}

interface TableStore {
  listTables(): Promise<LoreTable[]>;
  describeTable(id: string): Promise<TableDescription>;
  query(request: TableQueryRequest): Promise<TableQueryResult>;
}

interface ObjectStore {
  get(hash: string): Promise<Uint8Array | null>;
}
```

Local implementations:

- `LocalBuildStore`;
- `NodeSqliteCatalogStore`;
- `NodeSqliteTableStore`;
- `FileObjectStore`.

### 15.5 Studio scope by milestone

Milestone 1 ships five routes only:

1. **Overview** - active build, source counts, warnings, capabilities, dirty state, and the next plan summary.
2. **Sources** - artifact tree, normalized structure, status, authority, supersession, and provenance.
3. **Context Playground** - task, profile, budget, lexical ranking, selected items, and omissions.
4. **Versions** - build history, diff, activate, pack, and rollback.
5. **Diagnostics** - parser, watcher, SQLite/FTS5, path, and environment checks.

Milestone 2 adds **Tables** when structured data exists and an **Integrations** view for client status. Search remains a tab within Context Playground; Plan remains a panel rather than a separate application area. This keeps the first frontend an inspector, not a second product surface.

### 15.6 Studio constraints

- no chat interface;
- no source editing;
- no model-generated answer as the central experience;
- no deployment credential display;
- all build-changing actions show a plan and confirmation;
- keyboard-accessible and readable on a laptop-sized viewport.

---

## 16. Extensibility model

### 16.1 Stable ports

Define narrow interfaces for:

- `ArtifactParser`;
- `BuildStore`;
- `ActiveBuildProvider`;
- `CatalogStore`;
- `TableStore`;
- `ObjectStore`;
- `SemanticIndex`;
- `DeploymentTarget`;
- `ClientConnector`;
- `LoreRuntime`.

### 16.2 No dynamic plugin loader in v0.1

Built-in adapters are imported explicitly. A dynamic plugin system would add:

- arbitrary-code trust concerns;
- compatibility negotiation;
- package-resolution differences across operating systems;
- complex support and debugging;
- premature public API commitments.

Add external plugins only after two or more real third-party adapter needs reveal a stable contract.

### 16.3 Deployment target contract

```ts
interface DeploymentTarget {
  id: string;
  detect(): Promise<TargetDetection>;
  capabilities(): Promise<TargetCapabilities>;
  plan(input: DeployInput): Promise<DeployPlan>;
  apply(plan: DeployPlan): Promise<DeployReceipt>;
  verify(receipt: DeployReceipt): Promise<VerificationResult>;
  activate(receipt: DeployReceipt): Promise<ActivationReceipt>;
  rollback(buildId: BuildId): Promise<ActivationReceipt>;
}
```

Target rules:

- `plan` is read-only and reports build capabilities, target capabilities, and any loss;
- capability loss fails by default and requires a named `--allow-capability-loss <capability>` override;
- `apply` writes only build-scoped candidate data;
- `verify` must query the candidate explicitly;
- `activate` performs the smallest possible pointer mutation;
- deployment receipts are resumable and serializable;
- targets cannot change canonical build contents.

### 16.4 Future targets

Possible sibling packages:

- Docker + filesystem/SQLite;
- PostgreSQL + object storage;
- AWS Lambda/ECS + S3;
- Kubernetes;
- Vercel or another edge runtime.

These are not v0.1 deliverables.

### 16.5 Package-format stability

The public package schema uses JSON Schema and explicit `formatVersion`. TypeScript types are generated from or checked against the schema, not treated as the only specification.

---

## 17. Cloudflare reference backend

### 17.1 Role

Cloudflare is the first remote projection, not a dependency of local use and not the source of truth.

Default lexical deployment:

| Service | Role |
|---|---|
| Worker | Hono REST runtime, Streamable HTTP MCP, and optional Studio assets. |
| D1 | Build metadata, chunks, FTS5 lexical index, typed tables, and active pointer. |
| R2 | `.lorepack` archive and content-addressed normalized objects. |

D1 supports SQLite semantics and the FTS5 extension, allowing the lexical path to remain consistent without requiring Vectorize; R2 stores the immutable archive and normalized objects.[16][21][24]

Post-v0.1 semantic extension:

| Service | Role |
|---|---|
| Vectorize | Candidate semantic vectors stored under a build-scoped namespace after embedding compatibility has been proven. |

The v0.1 Cloudflare target advertises `lexical-search`, `structured-context`, and `table-query` only. It rejects a semantic-capable build by default rather than silently dropping that capability. A future Vectorize adapter may be enabled only when the target can generate query embeddings matching the build's complete `EmbeddingProfile`. Matching dimensions is insufficient. The target must pass fixed-string compatibility fixtures within a documented cosine tolerance before projection is allowed. Current Vectorize limits are ample for Lorepack's bounded projects, but do not remove this compatibility requirement.[22]

### 17.2 Services intentionally excluded

Do not require:

- Durable Objects;
- Queues;
- Workflows;
- Workers AI;
- AI Gateway.

The July 2026 Streamable HTTP direction supports stateless remote MCP requests, so protocol session state does not justify a Durable Object in the initial target.[20]

These services may become useful for a hosted control plane or server-side source synchronization later.

### 17.3 Projection model

```text
Lore build
  manifest + archive + objects -> R2
  artifacts + chunks + FTS5 + tables -> D1
  future compatible vectors -> Vectorize build namespace
  active_build_id + generation -> D1 project record
```

Every row, object reference, and vector is namespaced by:

```text
project_id + build_id
```

### 17.4 Projection implementation

Do not upload the local SQLite file as the remote database.

The adapter reads the canonical build and writes backend-specific batches:

- D1 schema migrations are target-owned;
- chunk and metadata inserts are batched;
- FTS5 rows are generated from canonical chunks;
- table schemas and rows are created with validated names;
- R2 writes use content hashes and skip existing objects;
- future Vectorize writes use build-scoped namespaces and large batches; verification polls a deterministic candidate query/sample until all expected records are visible or a deadline expires.[27]

D1 export has limitations around virtual tables, which is another reason to treat D1 as a projection rather than the canonical archive.[23]

### 17.5 Atomic activation

1. Ensure target resources and schema.
2. Create candidate build record.
3. Upload archive and objects to R2.
4. Insert D1 artifacts, chunks, FTS rows, and tables under the build ID.
5. For a future compatible semantic projection, insert vectors into a build-scoped namespace and wait for query visibility; timeout leaves the candidate inactive.[27]
6. Run candidate-scoped smoke searches, source reads, and table queries.
7. Record verification result and the exact runtime capability set.
8. Change `active_build_id` and its monotonic generation in one D1 transaction.
9. Run a public-endpoint health query and confirm the returned build ID.
10. Write a local deployment receipt.

Partially uploaded candidates are invisible because the Worker reads only the active build.

### 17.6 Cloudflare DX

One-time setup:

```bash
lore target add cloudflare
```

Expected behavior:

- use the pinned Wrangler dependency from the adapter;
- check or initiate Wrangler authentication;
- show resources that will be created;
- allow connection to existing resources;
- write non-secret resource identifiers under `.lore/targets/cloudflare.json`;
- store secrets through Wrangler/Cloudflare mechanisms, not in `lore.yaml`;
- perform a target capability check.

Deploy:

```bash
lore deploy cloudflare
```

Example plan:

```text
Target: cloudflare / personal
Build:  lore_b7f2a9c1d4e8

Resources
  = Worker lore-sarjbot
  = D1 lore-sarjbot
  = R2 lore-sarjbot
  - Vectorize unavailable in v0.1 target (no capability loss for this lexical build)

Projection
  + 2 artifacts
  ~ 1 artifact
  = 181 artifacts reused by content hash
  + 27 chunks
  + 122 table rows

Activation
  current lore_61c30ef2a7b4
  next    lore_b7f2a9c1d4e8
```

### 17.7 Remote authentication

Personal MVP modes:

- generated bearer token with stored hash;
- optional Cloudflare Access in front of the Worker.

The public runtime exposes only read-only context routes. Deployment and activation occur through the CLI using scoped Cloudflare credentials, never through model-facing MCP tools.

OAuth and team authorization belong to a future managed platform.

### 17.8 Rollback and retention

```bash
lore rollback --target cloudflare lore_61c30ef2a7b4
```

Rollback validates that the build remains complete, changes the pointer, and performs a health query.

Default retention:

- keep the active build;
- keep the previous five verified builds;
- never delete content-addressed objects still referenced by a retained build;
- show a cleanup plan before deletion.

---

## 18. Plan, build, deploy, and rollback lifecycle

### 18.1 `lore plan`

`plan` is side-effect free and compares:

- configured sources versus active build;
- content hashes;
- parser/lock changes;
- authority/status/supersession changes;
- table schemas and row counts;
- capabilities;
- target resources and active remote build.

It returns a machine-readable plan with `--json` for CI.

### 18.2 Incremental build

```text
same normalized path
+ same content hash
+ same parser version
+ same relevant config/rules
  -> reuse cached parsed output
otherwise
  -> rebuild artifact projections
```

Deletion removes content only from the new build. Previous builds remain immutable.

### 18.3 Human-readable diff

```text
Build lore_61c30ef2a7b4 -> lore_b7f2a9c1d4e8

Artifacts
  + research/customer-interviews-july.md
  ~ requirements/v2.docx
  - none

Rules
  ~ requirements/v2.docx authority 80 -> 100
  + requirements/v2.docx supersedes requirements/v1.docx

Context
  + 41 chunks
  ~ 14 chunks
  - 9 chunks

Tables
  ~ pricing.xlsx / operator_prices
    rows 1,982 -> 2,104
    columns + membership_price

Capabilities
  = lexical-search
  = structured-context
  = table-query
```

### 18.4 Activation semantics

Local activation:

1. build the candidate in a new directory;
2. validate and fsync critical files;
3. update `active_build_id` and a monotonic `active_generation` in `.lore/state.sqlite` in one transaction;
4. let each runtime switch at the next request boundary through `ActiveBuildProvider`;
5. retain the previous build and any handle still serving an in-flight request.

An in-flight request is allowed to finish on the old immutable build; a later request must observe the new generation. No response may mix builds. Remote activation uses the target's smallest atomic pointer operation and returns the activated build ID from the public endpoint before the deployment is considered complete.

### 18.5 Deploy semantics

`lore deploy target` performs:

```text
status -> plan -> build if dirty -> project candidate -> verify -> activate -> smoke check -> receipt
```

Flags:

```bash
lore deploy cloudflare --dry-run
lore deploy cloudflare --no-build
lore deploy cloudflare --yes
lore deploy cloudflare --resume <receipt-id>
```

### 18.6 Deployment receipt

```json
{
  "target": "cloudflare",
  "project": "sarjbot",
  "buildId": "lore_b7f2a9c1d4e8",
  "previousBuildId": "lore_61c30ef2a7b4",
  "state": "active",
  "deployedAt": "2026-07-30T20:00:00Z",
  "endpoint": "https://context.example.com/mcp",
  "verification": {
    "search": "passed",
    "sourceRead": "passed",
    "tableQuery": "passed"
  }
}
```

### 18.7 Rollback

Without arguments, roll back to the previous verified build:

```bash
lore rollback
```

Explicit:

```bash
lore rollback lore_61c30ef2a7b4
lore rollback --target cloudflare lore_61c30ef2a7b4
```

Rollback never rebuilds. If the requested remote projection is incomplete, fail without changing activation.

### 18.8 CI path

```yaml
steps:
  - run: pnpm install --frozen-lockfile
  - run: lore doctor --ci
  - run: lore plan --json > lore-plan.json
  - run: lore build --frozen
  - run: lore test
  - run: lore deploy cloudflare --yes --no-build
```

CI artifacts should include the plan, manifest, warnings, test results, and `.lorepack` archive.

---

## 19. Security and privacy defaults

### 19.1 Local privacy

- no account required;
- no telemetry by default;
- no source content leaves the machine;
- no model or network call in the core build path;
- remote adapters require explicit target setup;
- Studio and HTTP bind to localhost by default.

If telemetry is ever added, it must be opt-in, content-free, documented, and independently disableable.

### 19.2 Safe discovery

Default exclusions:

```text
.git/
node_modules/
.lore/
.env*
*.pem
*.key
id_rsa*
*.p12
*.pfx
.DS_Store
Thumbs.db
```

The init/plan flow warns about probable secret-shaped files before inclusion. This is a guardrail, not a claim to be a full secret scanner.

### 19.3 Filesystem safety

- resolve and verify every source path under its configured root;
- do not follow symlinks by default;
- do not parse archive containers in v0.1;
- cap individual artifact size;
- use temporary files and atomic rename for build outputs;
- normalize IDs independently of OS separators;
- never write into source directories except generated project config at the chosen root.

### 19.4 MCP and HTTP safety

- every model-facing tool is read-only;
- no build, deploy, source edit, or shell execution tool;
- local HTTP validates Origin and binds to loopback;
- request size and response budget limits;
- remote HTTP requires authentication;
- logs avoid source bodies by default;
- protocol errors never print secrets.

### 19.5 SQL safety

- parse and validate exactly one `SELECT` or `WITH ... SELECT` before preparation;
- open `DatabaseSync` with `readOnly: true`, `defensive: true`, `allowExtension: false`, and bounded `limits` for statement length, columns, expression depth, compound selects, VDBE operations, attached databases, variables, and pattern length;
- install `setAuthorizer()` to allow reads only from the catalog-approved tables and to deny writes, schema changes, `ATTACH`, `PRAGMA`, and extension operations at the SQLite engine boundary; these controls are available in the supported Node 24 line.[7]
- execute user-authored table SQL in a dedicated worker-thread executor so a hard deadline can terminate and replace the worker without blocking MCP/HTTP traffic;
- inject a default row limit, and enforce row, serialized-byte, and wall-clock ceilings;
- return table, sheet/range, and build provenance with every result;
- require equivalent deny-by-default enforcement from every remote adapter. The D1 adapter uses the same SQL AST allowlist, exposes no deployment/admin binding to model-facing routes, and does not advertise `table-query` if it cannot meet the contract.

### 19.6 Cloudflare safety

- least-privilege API token for provision/deploy;
- runtime bearer token separate from deployment credential;
- hashed runtime token storage;
- build/project namespace on every query;
- no administrative route in the public Worker;
- candidate data inaccessible until activation.

### 19.7 Supply-chain discipline

- lock dependencies;
- publish npm provenance where supported;
- generate SBOMs for releases;
- run dependency and license checks;
- avoid post-install scripts in core packages;
- document every optional native dependency separately.

---

## 20. Testing and quality gates

### 20.1 Clean-install matrix

Every release candidate installs and runs on:

- macOS 14+;
- Windows 11 x64;
- Ubuntu 22.04+ x64;
- `>=24.15 <25` (Node 24 LTS).

The test image intentionally lacks Python and native compiler tools.

### 20.2 Golden parser fixtures

For every format, store:

- source fixture;
- expected artifact metadata;
- expected node tree;
- expected table schema/data sample;
- expected locators;
- expected warnings;
- canonical hash.

Include malformed and edge-case fixtures, not only happy paths.

### 20.3 Determinism tests

Build the same project:

- twice on one machine;
- on Windows and POSIX;
- in different absolute workspace paths;
- with different file enumeration order.

The full build ID, canonical manifest, and logical hash roots must match. Package checksums must validate each produced archive, but physical `context.sqlite` bytes are not required to match across operating systems or SQLite patch revisions. Operational build receipts are expected to differ.

### 20.4 Windows/path tests

Test:

- drive letters and UNC-like rejection rules;
- backslash/native display versus POSIX canonical IDs;
- case-only filename collisions;
- long paths within supported OS settings;
- atomic editor saves;
- rename/delete/recreate sequences;
- PowerShell quoting in generated client commands.

### 20.5 Watcher tests

- events during initial scan;
- duplicate events;
- chunked large-file writes;
- atomic rename saves;
- rapid add/edit/delete;
- watcher restart and reconciliation;
- no-op hash changes;
- Ctrl-C during rebuild.

### 20.6 Adapter contract tests

Run the same suite against:

- local catalog/table/object/build stores;
- `ActiveBuildProvider`, including an in-flight old-build request and a next-request new-build switch;
- Cloudflare integration environment where credentials are available;
- future adapters.

A future semantic target additionally runs fixed-string embedding-profile compatibility tests and delayed-write visibility tests before it can advertise `semantic-search`.

### 20.7 Retrieval fixtures

Each fixture declares:

- task/query;
- required source IDs;
- forbidden superseded sources by default;
- acceptable alternatives;
- maximum estimated budget;
- provenance expectations;
- omission expectations.

Track lexical ranking regressions without claiming general answer quality.

### 20.8 Client connector tests

For each supported client:

- detect installed/not installed;
- generate project-scoped config;
- merge without deleting unrelated entries;
- dry-run output;
- backup and restore;
- disconnect only Lorepack-owned entry;
- `server/discover`/`tools/list` verification against a fixture server, plus a backward-compatibility fixture;
- unsupported client version fallback to copyable snippet.

### 20.9 Security tests

- path traversal;
- symlink escape;
- malformed PDFs and Office files;
- SQL injection and multi-statement attempts;
- oversized requests/responses;
- localhost Origin validation;
- auth bypass;
- secret exclusion from manifest/logs;
- malicious config values.

### 20.10 Performance benchmarks

Version benchmark data and reference-machine details. Gate releases on the scale envelope in section 5, but do not optimize beyond measured bottlenecks.

### 20.11 End-to-end acceptance path

A clean environment must pass:

```bash
npm install -g @lorepack/cli
lore dev ./fixtures/product-research
lore connect <fixture-client>
lore export --task "Summarize the launch decision"
# edit one source
lore plan
lore build
lore diff
lore rollback
```

A Cloudflare integration environment additionally passes deploy, remote MCP search, and remote rollback.

---

## 21. MVP delivery milestones

### Milestone 0 - Lifecycle vertical slice

Deliver:

- Markdown/plain-text source;
- discovery and hashing;
- minimal canonical model;
- deterministic SQLite build;
- FTS5 search;
- immutable build ID;
- active pointer;
- `init`, `plan`, `build`, `search`, `diff`, and `rollback`.

**Exit criterion:** editing one file creates a new immutable version, shows a correct diff, and rolls back without re-indexing.

This milestone proves the differentiator before broad parser work.

### Milestone 1 - Two-command local product

Add:

- `lore dev ./folder` auto-init path;
- watch/reconciliation flow;
- MCP stdio with `--ensure-current`;
- REST and local Streamable HTTP;
- `lore_context_for_task`;
- bounded export with 24k chat default and complete omissions;
- minimal five-route Studio: overview, sources, context playground, versions, diagnostics;
- `lore connect claude-code` plus a safe generic snippet path;
- plan/dry-run, non-global scope, server verification, and disconnect;
- live activation so connected clients use the new build on their next request without reconnecting;
- `lore doctor`;
- macOS/Windows/Linux clean-install CI.

**Exit criterion:** on a clean supported machine, a new user runs `lore dev ./folder` and `lore connect claude-code`, approves the client trust prompt, and receives grounded context without an account, model download, Python, Docker, native compilation, manual JSON, or stale-build ambiguity.

### Milestone 2 - Real mixed artifacts and clients

Add:

- HTML;
- text PDF;
- DOCX;
- CSV;
- XLSX;
- typed table catalog and safe SQL;
- authority/status/supersedes rules;
- parser warnings and inspection;
- `lore connect codex` and `lore connect vscode`;
- path/watcher/client fixtures across supported platforms;
- scale-envelope benchmarks.

**Exit criterion:** the user's real mixed project folder produces useful bounded context with reliable provenance and spreadsheet queries, and all three supported clients connect without hand-editing configuration.

### Milestone 3 - Cloudflare reference projection

Add:

- target setup;
- Worker/Hono runtime;
- D1 schema and FTS5 projection;
- R2 archive/objects;
- candidate verification;
- atomic activation;
- remote auth;
- deployment receipts and rollback.

**Exit criterion:** one command deploys the exact local build remotely, and rollback changes only the active pointer.

### Milestone 4 - Open-source hardening and v0.1

Add:

- package-format specification;
- contributor and architecture docs;
- examples;
- npm provenance/SBOM;
- release automation;
- security policy;
- compatibility matrix;
- performance report;
- stable v0.1 release.

### Explicitly after v0.1

- optional semantic-local package with the bounded download/scan contract in section 5.6;
- semantic deployment only after exact `EmbeddingProfile` compatibility and asynchronous query-visibility gates;
- Docker/PostgreSQL backends;
- SaaS source connectors;
- hosted registry/control plane;
- team permissions and OAuth;
- OCR/visual artifact parsing.

---

## 22. Open-source and commercial boundary

### 22.1 Apache-2.0 open source

Open source:

- CLI and DX flows;
- compiler and deterministic IR;
- package/build specification;
- built-in parsers;
- local backend and runtime;
- plan, diff, activation, and rollback;
- MCP, REST, export, and SDK;
- Studio;
- client connectors;
- Cloudflare deployment adapter;
- tests and benchmarks;
- optional semantic adapter when created.

Apache-2.0 is recommended for permissive adoption and an explicit patent grant.

### 22.2 Future paid platform

A paid service can provide:

- managed build registry;
- hosted deployment and domain management;
- continuous source connectors;
- server-side compilation;
- team projects;
- source permission synchronization;
- OAuth/SSO;
- audit logs;
- build and retrieval analytics;
- policy and retention controls;
- private networking;
- support and SLAs.

The commercial value is operations, governance, and collaboration. Local users should not need the hosted product to retain access to their builds or protocol interfaces.

### 22.3 Trust boundary

The open package format and local runtime prevent lock-in. A hosted platform may store and project builds, but users can always export a `.lorepack` and run it locally or through another adapter.

---

## 23. Architecture decision record

| Decision | Choice | Rationale |
|---|---|---|
| Product wedge | Versioned context lifecycle | Local MCP retrieval is crowded; build/plan/deploy/rollback is the defensible layer. |
| Working codename | Lorepack | Conveys accumulated knowledge packaged as a portable artifact. |
| Main language | TypeScript | One stack across CLI, compiler, MCP, edge runtime, SDK, and UI. |
| Node baseline | 24.15+ LTS | Current LTS and bundled `node:sqlite` release-candidate API.[6][7] |
| Local binding | `node:sqlite` | Avoid native npm add-on installation failures; isolate RC API behind a port. |
| Local lexical search | SQLite FTS5 | Mature deterministic retrieval and supported by both local SQLite and D1.[8][16] |
| Semantic default | Disabled/not installed | Preserves zero-network, zero-native-dependency first run. |
| Table model | Typed SQLite tables | Keeps structured data queryable and provenance-aware. |
| Build command | One `lore build` | Hide compile/index/package stages without hiding inspectability. |
| Canonical state | Immutable Lore build identified by logical hashes | Enables reproducibility without coupling identity to SQLite page layout. |
| Runtime switching | Request-scoped active-build handles | Connected clients see activation or rollback on the next request without mixed-build responses. |
| Archive | Inspectable `.lorepack` ZIP | Portable, standard, and non-proprietary. |
| Primary AI protocol | MCP | Standard model-facing tools/resources; stdio and HTTP support.[1][2] |
| Universal fallback | Bounded Markdown/JSON export | Works with clients that cannot connect to MCP. |
| Client setup | Safe `lore connect` adapters | Maps a conceptual workspace scope per client, removes manual config, and avoids silent global mutations. |
| Cloudflare stack | Worker + D1 + R2 for v0.1 | Minimal lexical remote projection; Vectorize is post-v0.1 and requires exact query-embedding compatibility plus visibility verification. |
| Plugin model | Typed ports, no dynamic loader | Extensible without premature security and compatibility complexity. |
| License | Apache-2.0 | Broad adoption and patent grant. |

---

## 24. Risks and mitigations

### 24.1 The product is mistaken for another RAG server

**Risk:** Users compare Lorepack only on parser count or semantic retrieval quality.  
**Mitigation:** lead the README, website, demo, and milestones with plan/build/diff/deploy/rollback. Retrieval is described as a runtime capability, not the category.

### 24.2 Lexical retrieval misses semantic paraphrases

**Risk:** Default retrieval is less forgiving than embeddings.  
**Mitigation:** strong path/title/heading weighting, task-oriented queries, hierarchy expansion, explicit filters, transparent omissions, and a later opt-in semantic adapter. Do not sacrifice first-run reliability before validating the lifecycle wedge.

### 24.3 `node:sqlite` is release candidate

**Risk:** API behavior or performance may change.  
**Mitigation:** pin Node LTS, use a narrow API subset, isolate behind ports, contract-test, and retain a replacement path. This trade-off avoids the confirmed installation fragility of native add-ons.[7][19]

### 24.4 Parsing quality varies

**Risk:** PDFs and spreadsheets can be irregular.  
**Mitigation:** conservative v0.1 formats, visible warnings, source inspection, golden fixtures, and build failure for unsupported-loss cases. Do not claim OCR or visual-layout support.

### 24.5 Watchers are not a source of truth

**Risk:** duplicate, missed, or partial-write events create stale builds.  
**Mitigation:** reconciliation scan, stable-write wait, content hashing, duplicate no-ops, periodic optional rescan, and cross-platform tests.

### 24.6 Source precedence is misunderstood

**Risk:** `authority` is treated as factual certainty.  
**Mitigation:** label it as a user-declared ranking hint everywhere; never automatically claim conflict resolution.

### 24.7 Context bundles still become too large

**Risk:** A broad query floods the model.  
**Mitigation:** strict profiles, budget reserve, diversity, omissions, alternative sources, and a default 24k chat export rather than dumping the corpus.

### 24.8 Client configuration formats change

**Risk:** `lore connect` breaks or corrupts configuration.  
**Mitigation:** prefer official CLIs, non-global workspace mapping, plan/dry run, schema fixtures, atomic merge, backups, version detection, and snippet fallback.

### 24.9 MCP evolves

**Risk:** protocol revisions affect transports or schemas.  
**Mitigation:** isolate MCP, pin official SDK, run compatibility tests, and keep REST/runtime contracts independent.[1][2]

### 24.10 Remote projection partially fails

**Risk:** D1, R2, or a future Vectorize namespace contains partial candidate data.  
**Mitigation:** build namespace, resumable receipt, candidate verification, active pointer, and retention cleanup only after activation. Future vector candidates must also become query-visible before activation.[27]

### 24.11 A connected client keeps serving the previous build

**Risk:** activation changes a pointer but a long-lived runtime continues using its existing SQLite handle.  
**Mitigation:** request-scoped `BuildHandle` acquisition keyed by a monotonic generation; old handles drain, and the next request observes the new build without reconnecting.

### 24.12 Semantic vectors and remote query embeddings are incompatible

**Risk:** local corpus vectors and remote query vectors share dimensions but not an embedding space, producing plausible but invalid retrieval.  
**Mitigation:** record the complete embedding profile, reject mismatches, run fixed compatibility fixtures, and make capability loss explicit. Cloudflare v0.1 remains lexical-only.

### 24.13 Scope expands into a knowledge platform

**Risk:** connectors, chat, memory, agents, and enterprise permissions delay the wedge.  
**Mitigation:** every v0.1 feature must improve one of four promises: build, inspect, connect, or deploy durable context.

---

## 25. Initial implementation backlog

### Foundation

- pnpm workspace and package boundaries.
- `engines.node` guard for `>=24.15 <25`.
- JSON Schemas for config, lockfile, manifest, plan, receipt, and runtime requests.
- `node:sqlite` capability probe and migrations.
- canonical POSIX path/ID utilities.
- content-addressed object store.
- atomic build-directory helpers, canonical logical hash roots, and transactional ID/generation activation.

### Lifecycle vertical slice

- `lore init`.
- discovery and `.loreignore`.
- fingerprint/cache.
- Markdown/plain-text parser.
- deterministic nodes/chunks.
- FTS5 index.
- build validator, canonical roots, and full SHA-256 ID.
- `plan`, `build`, `status`, `diff`, `activate`, `rollback`.

### Runtime

- `LoreRuntime` interface.
- lexical ranking and filters.
- context profiles and budget accounting.
- source read.
- build description.
- Hono routes.

### Developer experience

- progress renderer.
- actionable error taxonomy.
- `doctor` and `config show --effective`.
- watch/reconciliation flow.
- local dev supervisor.
- clean cancellation.
- Windows command/path handling.

### Interfaces

- MCP stdio with `--ensure-current`, `--active-only`, and explicit stale recovery.
- MCP Streamable HTTP.
- small MCP tool surface.
- REST SDK.
- Markdown/JSON export and omission report.

### Studio

- overview with plan summary.
- sources.
- context playground with search/debug tab.
- versions.
- diagnostics.
- later milestone: tables and integrations views.

### Artifact formats

- HTML.
- PDF text.
- DOCX.
- CSV.
- XLSX.
- typed table catalog/import.
- constrained query validator.

### Rules

- status/authority/supersedes resolution.
- cycle and missing-target validation.
- ranking and bundle behavior.
- rule inspection in CLI/Studio.

### Client connection

- connector port.
- Claude Code adapter.
- Codex adapter.
- VS Code adapter.
- generic snippet renderer.
- dry run, client-specific workspace mapping, backup, protocol/client verify, and disconnect.

### Cloudflare

- target detection/setup.
- Worker/Hono runtime.
- D1 migrations and FTS5 projection.
- R2 archive/object upload.
- candidate-scoped verification.
- active pointer/generation, request-scoped hot switching, and target capability planning.
- auth token setup.
- remote rollback and retention.

### Release hardening

- cross-platform clean-install CI.
- parser/path/watcher fixtures.
- performance benchmarks.
- SBOM/provenance.
- package-format docs.
- examples and README demo.

---

## 26. Definition of MVP success

Lorepack v0.1 succeeds when a technical user can:

1. install it without Python, Docker, a compiler toolchain, or a model download;
2. run `lore dev ./artifacts` and receive a verified active build;
3. inspect exactly what was parsed and what was excluded;
4. connect Claude Code, Codex, or VS Code through one safe command with no global mutation by default;
5. let an agent launch against a source-checked active build and retrieve task-specific context without scanning every artifact;
6. create a 24k-budget context export for a web chat;
7. query CSV/XLSX-derived tables without flattening them into prose;
8. trace every result to a document section, page, sheet, cell range, or line range;
9. declare an active source, archive old material, and mark supersession deterministically;
10. edit/add/delete artifacts and rebuild only affected outputs;
11. see a human-readable plan and build diff;
12. activate and roll back locally without recompilation;
13. deploy the exact build to Cloudflare through one command;
14. verify and activate the remote candidate atomically;
15. use the full local workflow without an account or hosted service;
16. obtain the same build ID on supported operating systems from the same canonical inputs.

The product has not succeeded merely because it can answer questions over PDFs. It succeeds when context behaves like reliable infrastructure.

---

## 27. README and demo sequence

The first public demo should make the wedge obvious in under three minutes.

### 27.1 Start

```bash
lore dev ./project-context
lore connect claude-code
```

Show:

- no model/API setup;
- active build ID;
- Studio source inspection;
- client launch verifies freshness and the agent retrieves bounded context.

### 27.2 Change

Edit a requirement and add one CSV row:

```bash
lore plan
lore build
lore diff
```

Show:

- unchanged work reused;
- exact document/table changes;
- new immutable ID;
- active version switch.

### 27.3 Recover

```bash
lore rollback
```

Show immediate return to the previous build without parsing or indexing.

### 27.4 Deploy

```bash
lore deploy cloudflare
```

Show:

- resource/build plan;
- candidate verification;
- atomic activation;
- remote MCP endpoint using the same build ID.

### 27.5 Homepage message

> **Stop re-uploading your project to AI. Build it once, version every change, and let any agent fetch the right context on demand.**

Secondary line:

> Local-first and open source. MCP, HTTP, and chat-ready exports. Deploy the same immutable build locally or to Cloudflare.

---

## 28. Final recommendation

Proceed with **Lorepack**, but build it as a **versioned context build system**, not as a local RAG product.

The simple user journey is:

```bash
lore dev ./artifacts
lore connect claude-code
```

The durable engineering model is:

```text
artifacts
  -> deterministic compiler
  -> immutable Lore build
  -> plan / diff / validate
  -> local activation or backend projection
  -> MCP / HTTP / export
  -> atomic rollback
```

The most important MVP discipline is what the design does **not** require:

- no default embeddings;
- no remote semantic assumption in v0.1;
- no native npm add-on;
- no Python sidecar;
- no Docker;
- no hosted account;
- no dynamic plugin framework;
- no chat UI;
- no connector catalog;
- no automatic truth claims.

The product should feel magical because the runtime starts in one command, client connection is a second safe command, updates are incremental, and deployment is atomic. It should remain trustworthy because every default is inspectable, every result has provenance, every mutation has a plan, and every active version can be rolled back.

---

## References

1. Model Context Protocol specification, transports (2026-07-28): https://modelcontextprotocol.io/specification/2026-07-28/basic/transports  
2. Official Model Context Protocol TypeScript SDK v2: https://github.com/modelcontextprotocol/typescript-sdk  
3. Claude Code MCP configuration and scopes: https://code.claude.com/docs/en/mcp  
4. OpenAI Codex and ChatGPT desktop MCP configuration: https://developers.openai.com/codex/mcp  
5. Visual Studio Code MCP server configuration: https://code.visualstudio.com/docs/agent-customization/mcp-servers  
6. Node.js release schedule and Node 24 LTS status: https://nodejs.org/en/about/previous-releases  
7. Node.js `node:sqlite` API and release-candidate status: https://nodejs.org/docs/latest-v24.x/api/sqlite.html  
8. SQLite FTS5 documentation: https://www.sqlite.org/fts5.html  
9. Chokidar cross-platform file watching: https://github.com/paulmillr/chokidar  
10. pnpm workspaces: https://pnpm.io/workspaces  
11. Vitest guide: https://vitest.dev/guide/  
12. Knowledge RAG, local hybrid MCP document server: https://github.com/lyonzin/knowledge-rag  
13. kb-mcp, local hybrid document MCP server with watch mode: https://github.com/alphabet-h/kb-mcp  
14. kb, local multi-format hybrid search and MCP tool: https://github.com/ariel-frischer/kb  
15. Hono documentation: https://hono.dev/docs/  
16. Cloudflare D1 supported SQL extensions including FTS5: https://developers.cloudflare.com/d1/sql-api/sql-statements/  
17. Transformers.js model download progress and local-files-only controls: https://huggingface.co/docs/transformers.js/api/utils/hub  
18. ONNX Runtime Node binding and prebuilt platform support: https://onnxruntime.ai/docs/get-started/with-javascript/node.html  
19. Example `better-sqlite3` Node 24 prebuild gap: https://github.com/WiseLibs/better-sqlite3/issues/1384  
20. Cloudflare MCP servers and July 2026 stateless Streamable HTTP support: https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/  
21. Cloudflare D1 overview: https://developers.cloudflare.com/d1/  
22. Cloudflare Vectorize limits: https://developers.cloudflare.com/vectorize/platform/limits/  
23. Cloudflare D1 import/export limitations for FTS5 virtual tables: https://developers.cloudflare.com/d1/best-practices/import-export-data/  
24. Cloudflare R2 overview: https://developers.cloudflare.com/r2/  
25. Cloudflare D1 platform limits: https://developers.cloudflare.com/d1/platform/limits/  
26. MCP 2026-07-28 key changes and backward compatibility: https://modelcontextprotocol.io/specification/2026-07-28/changelog
27. Cloudflare Vectorize batching and asynchronous query visibility: https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/
