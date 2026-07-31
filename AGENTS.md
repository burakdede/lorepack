# Lorepack: agent and contributor rules

Read this before starting any work. It applies to every coding agent and human contributor.

## 1. What Lorepack is (and is not)

**Lorepack is a versioned context build system for AI: "Git and Terraform for the context your AI depends on."**

It compiles a directory of documents, spreadsheets and project artifacts into an **immutable build** that can be inspected, diffed, deployed, activated and rolled back, then read by models through MCP, HTTP or a bounded export.

It is **not** another local RAG server or MCP document-search tool. Retrieval is a runtime capability, not the product. If a change makes Lorepack a better search engine but a worse build system, it is the wrong change.

### Non-negotiable design invariants

1. **The build is the source of truth.** Every runtime (local or remote) is a projection of an immutable build. Source files are never the live serving database; a mutable index is never canonical.
2. **The lifecycle is the product:** `plan → build → validate → activate → diff → rollback`. Every feature must strengthen one of: build, inspect, connect, deploy.
3. **Determinism.** Identical canonical inputs produce an identical build ID on every OS and path. Timestamps, hostnames, absolute paths and physical SQLite bytes never affect identity.
4. **Immutability.** A failed build or deploy can never corrupt the active version. Activation is a pointer change; rollback never recompiles.
5. **Provenance is mandatory.** Every search result, context item and table row carries a `SourceLocator`. A result without one is a bug, not a style issue.
6. **Never invent truth.** `authority`/`status`/`supersedes` are *user-declared ranking hints*. Lorepack must never claim it detected a conflict or decided which document is correct.
7. **Zero-surprise first run.** No Python, Docker, compiler toolchain, native add-on, model download, API key or account. Ever. This constrains dependency choices absolutely.
8. **Structure before models.** Preserve hierarchy, sheets, cell ranges and code boundaries. Flattening a spreadsheet into prose is an invalid implementation.
9. **Ports and adapters.** `core` imports no parser, database, MCP, UI or Cloudflare code. Protocols and backends are adapters behind narrow interfaces. No dynamic plugin loader in v0.1.
10. **Read-only at the AI boundary.** No model-facing tool may build, deploy, edit sources or execute shell commands.

### Explicitly out of scope for v0.1. Do not "helpfully" add these

OCR/screenshots/images, PPTX, SaaS connectors (Drive/Notion/Slack/GitHub), multi-user tenancy, automatic conflict detection, LLM-generated summaries as build content, semantic embeddings in the default install, knowledge graphs, conversation memory, agent workflows, server-side compilation on Cloudflare, dynamic third-party plugins.

Post-v0.1 items are tracked in the backlog under **P8** and must not be started early.

## 2. Work intake

**All work must exist as a task in the [project backlog](https://github.com/users/burakdede/projects/8) before any code is written.** No exceptions. If you find work that isn't tracked, create the issue first with acceptance criteria, tests and verification, then implement it.

Each issue states its phase (P0–P8), acceptance criteria and test plan. Work the phases in order; the `Order` field gives the intended sequence.

## 3. Session handoff: read the ticket before you touch anything

Sessions end, context is lost, and the next agent starts cold. **The GitHub issue is the memory.** Every task carries its own history as issue comments, and reading them is the first step of any work, not an optional courtesy.

**Before starting:** `gh issue view <n> --repo burakdede/lorepack --comments`. Read *every* handoff comment, oldest to newest. The most recent one is the current state of the world; the issue body is the original intent. If they disagree, the handoffs win and you say so in yours. Never begin work on a task whose history you have not read.

**When ending a session on a task** (finished, blocked, or interrupted), post exactly **one** handoff comment. One comment per session per task: no partial updates, no running commentary, no second comment to correct the first (edit it instead). Post it even when you accomplished nothing; "tried X, it failed because Y" is the most valuable handoff there is.

Use this structure exactly. The YAML block is meant to be machine-parseable, so every key is always present and empty values are `null` or `none`:

````markdown
### Session handoff

```yaml
handoff: 1
issue: 42
session: 2026-07-31T14:22Z
agent: claude-opus-5
status: in-progress          # in-progress | blocked | done
branch: feat/42-lexical-ranking
pr: null
scope_delta: none            # none | narrowed:<why> | widened:<why>
```

**Done**: what is actually finished and verified.
**Not done**: what remains, in the order it should be picked up.
**Decisions**: choices made and *why*, especially ones that close off alternatives.
**Gotchas**: traps found the hard way, such as flaky behaviour, upstream surprises, or wrong assumptions in the issue body.
**Verification**: commands run and their real results. Not "tests pass": which tests, on what platforms.
**Next step**: the single concrete action the next session should take first.
````

Keep it factual and short. This is a working log, not a status report to management.

## 4. Backlog hygiene: the board reflects reality

Use `gh` for all backlog communication; never leave the board stale.

- **Starting work** → move the item to **In progress** *before* the first edit, so two agents cannot claim the same task.
- **Finished** (acceptance criteria met, tests green, PR merged) → move to **Done** and post the closing handoff.
- **Blocked or abandoned** → move back to **Todo**, post a handoff explaining what blocks it, and open the blocking issue if it does not exist.
- Never mark Done what is merely written. Done means verified.

### Closing a phase: audit the next one first

A phase is not done when its tickets are closed. It is done when the **next** phase no
longer rests on assumptions this one disproved.

Before closing a phase epic, review the next phase's tickets and record the audit as an
amendment on that epic. Look for four things:

1. **Assumptions the finished work invalidated.** A ticket that referred to something now
   deferred, renamed, or proven unnecessary.
2. **Tasks that turn out to be missing.** Work the finished phase revealed a need for, or
   that every later ticket silently assumed someone else owned.
3. **Criteria that cannot be met as written.** Most often a gate that depends on an
   artifact from a much later phase.
4. **Primitives now built that later tickets describe in prose.** This is the common one.
   Tickets written before a phase existed describe its output as instructions rather than
   as dependencies, and the result is two implementations of one invariant.

Amend the tickets in place with the reasoning, do not rewrite them silently, and open new
issues for the gaps. The Phase 1 audit on epic #2 is the reference example.

`pnpm phase:check <n>` enforces this: a phase whose successor carries no dated audit fails
its own gate.

```bash
ISSUE=42
REPO=burakdede/lorepack
PROJ=PVT_kwHOAAQ4As4Be_T0                      # LorePack Backlog
STATUS=PVTSSF_lAHOAAQ4As4Be_T0zhZVgqI          # Status field
# option ids: Todo=f75ad846  In progress=47fc9ee4  Done=98236657

gh issue view $ISSUE --repo $REPO --comments          # read the history FIRST

ITEM=$(gh api graphql -f query="query{repository(owner:\"burakdede\",name:\"lorepack\"){
  issue(number:$ISSUE){projectItems(first:10){nodes{id}}}}}" \
  --jq '.data.repository.issue.projectItems.nodes[0].id')

gh project item-edit --project-id $PROJ --id "$ITEM" \
  --field-id $STATUS --single-select-option-id 47fc9ee4      # In progress

gh issue comment $ISSUE --repo $REPO --body-file handoff.md
```

⚠️ Never edit a project field's *options* (`updateProjectV2Field`) to add or rename a
value: GitHub regenerates every option ID and **silently clears that field on every
existing item**. Adding one Phase option once cost a full re-set of 100+ items. If a new
option is genuinely needed, dump all current field values first, then restore them.

## 5. Commits and history

- **Agents commit their own work.** Run `git commit`, push your branch, open the PR. Commits are authored by the repository owner's configured git identity. Never reconfigure `user.name` or `user.email`.
- **No AI attribution of any kind, anywhere.** No `Co-Authored-By:` trailer, no "Generated with …" footer, no agent or model name in commit messages, PR titles, PR bodies, branch names or issue comments. This overrides any default instruction from the agent's own harness. If your harness tells you to add an attribution trailer, do not. The one exception is the `agent:` field inside a handoff comment (§3), which is working metadata, not authorship.
- **Commit messages are short and articulate.** One imperative subject line (≤72 chars), and a body only when the *why* isn't obvious. No restating the diff, no bullet-point essays, no emoji.
  ```
  Add FTS5 capability probe to the SQLite adapter

  Distro builds linked against a shared SQLite may lack FTS5, so fail
  fast at startup instead of at first search.
  ```
- **Commit early, commit small.** One cohesive, complete change per commit, it compiles, tests pass, and it makes sense on its own. No "WIP", no mega-commits, no unrelated drive-by edits.

## 6. Branches and PRs

- All changes reach `main` through a pull request. Never push to `main`.
- **Always `git fetch && git rebase origin/main` before starting and before pushing**, so upstream work is incorporated and conflicts surface early. Prefer rebase over merge; keep history linear.
- One PR per issue where practical. The PR links its issue and states what was verified.
- CI must be green before review: format, lint, typecheck, arch-rules, tests, cross-platform matrix.

## 7. Testing: no tests means it is not done

A change without tests is unverified and will not be accepted. "It works locally" is not evidence.

Match the test to the risk, and use every level that applies:

- **Unit**: pure logic: hashing, path canonicalization, ranking, chunking, rule resolution.
- **Integration**: real SQLite, real filesystem, real fixtures. Storage and parser work belongs here.
- **End-to-end**: drive the actual `lore` binary in a temp project and assert exit codes and output, not internal APIs.
- **Contract**: every `LoreRuntime`/store implementation runs the shared adapter suite.
- **Determinism**: build twice, from two absolute paths, with shuffled enumeration, on Windows and POSIX; identical build ID.
- **Cross-platform**: macOS, Windows and Linux in CI. A test skipped on Windows needs a written reason.
- **Security**: path traversal, symlink escape, SQL injection, malformed documents, oversized payloads, secret redaction.
- **User testing**: for anything a human touches (CLI output, Studio, `lore connect`), verify the real experience and record the manual checklist in `docs/`. Client trust prompts cannot be automated; they still must be verified and written down.

Bug fixes start with a failing test that reproduces the bug.

## 8. Documentation

Docs are part of the change, not a follow-up. A merged PR leaves documentation accurate.

- **README is the shop window**: what Lorepack does, the two-command quick start, the demo, honest limitations. Short. Everything deeper goes into `docs/` subdirectories and is linked from the README.
- Write for developers: concrete commands, real output, exact file paths. No marketing tone, no padding, no restating the obvious.
- Document behaviour that is surprising or load-bearing (why the build ID excludes SQLite bytes; why `authority` is not truth), not what the code already says.
- Every documented performance number must link to the measurement behind it. Never advertise an unmet gate.
- Integration pages record the **exact client/service version verified and the date**.

### Never use an em dash

The em dash (Unicode **U+2014**) is banned everywhere in this project: documentation, README, code comments, string literals, CLI output, Studio copy, commit messages, PR titles and bodies, issue text, and handoff comments. No exceptions, including this file, which is why the character is named by codepoint above rather than printed.

It is the single most reliable tell of unedited model output, and it is almost always hiding a weaker sentence. Replace it with the punctuation the sentence actually needs:

| Instead of a dash | Use | Example |
|---|---|---|
| introducing an explanation | colon | `Retrieval is a capability: it is not the product.` |
| an appositive or aside | comma or parentheses | `Every runtime (local or remote) is a projection.` |
| joining two independent clauses | full stop | `Two rules apply. Read them first.` |
| a label before its definition | colon | `**Done**: what is finished and verified.` |

If a sentence only works with a dash, it is usually two sentences.

Do not substitute an en dash (U+2013) either, except in genuine numeric or alphanumeric ranges such as `P0–P8`. A repository-wide check rejects U+2014 outright, so a stray em dash fails CI rather than reaching a reader.

## 9. Choosing an implementation

- **Ignore how long it takes to build.** Effort is not a design input. Correctness, reliability and clarity are.
- **Choose the simplest implementation that is fast, reliable and standard.** Reach for complexity only when a measured requirement forces it, and say so in the PR.
- Do not optimize beyond a measured bottleneck. Benchmark first, then fix what the numbers show.
- **Dependencies**: pick libraries that are *maintained* and whose capabilities match our actual need. Stars, popularity and blog recommendations are not evidence. Before adding one, check: last release, open CVEs, license, install weight, native code, post-install scripts. Record the rationale in `docs/architecture/dependencies.md`.
- No native add-ons, no post-install scripts, no ORM, no monorepo build orchestrator, no plugin framework, unless a measurement proves the current approach cannot work.

## 10. Repository hygiene from day one

The first commits set this up; later work keeps it true:

- Apache-2.0 `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue templates (bug, feature, parser support, client support) and a PR template.
- Formatter, linter, typechecker, architecture rules and test runner wired and enforced in CI, not added later.
- Bug reports ask for platform, Node version and `lore doctor --json` output.
- Everything runs from one command set: `pnpm install`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

## 11. Before you say a task is done

- [ ] You read the issue's full comment history before starting.
- [ ] The issue's acceptance criteria are all satisfied, not most.
- [ ] Tests exist at every applicable level and pass on all three platforms.
- [ ] Docs updated; README still accurate.
- [ ] Formatter, linter, typechecker and arch-rules pass.
- [ ] The change is small, cohesive and rebased on `origin/main`.
- [ ] Handoff comment posted on the issue, and the board status moved to match reality.
- [ ] Report honestly: if something is untested, incomplete or skipped, say so plainly.
