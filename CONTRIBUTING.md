# Contributing to Lorepack

Lorepack is pre-v0.1 and still changing quickly. Contributions are welcome, but the
project has load-bearing invariants. Read this file before opening a pull request.

## Authority

[`AGENTS.md`](AGENTS.md) is the authoritative working agreement for humans and coding
agents. It defines the product direction, non-negotiable invariants, out-of-scope work,
backlog workflow, handoff protocol, commit rules, PR rules and testing bar. This file
does not restate those rules. It explains how to carry them out locally.

## Setup

Requirements:

- Node.js `>=24.15 <25`
- pnpm `11.18.0`
- GitHub CLI `gh`, for backlog and PR work

No Python, compiler toolchain, Docker, native add-on, model download, API key or account is
required for the default install. If the default path needs one, treat that as a bug.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm verify
```

Useful focused commands:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm acceptance
pnpm test:e2e
pnpm check:no-native
pnpm check:templates
pnpm check:license-policy
```

## Repository Layout

| Path | Purpose |
|---|---|
| `packages/core` | Domain types, schemas, ports, deterministic identity rules |
| `packages/compiler` | Build orchestration and canonical build creation |
| `packages/parsers` | Format adapters behind compiler boundaries |
| `packages/backend-local` | Local SQLite and filesystem runtime projection |
| `packages/runtime` | Read-only runtime capabilities over a build |
| `packages/cli` | `lore` command line and local Studio server |
| `packages/mcp` | MCP transport surface |
| `packages/deploy-cloudflare` | Cloudflare projection and deployment target |
| `packages/connect-clients` | Client configuration adapters |
| `tools/acceptance` | End-to-end scenarios against the real binary |
| `tools/test-support` | Shared fixtures, determinism and runtime-contract helpers |
| `docs/architecture` | Design decisions and invariants that reviewers rely on |

`core` must stay behind ports. It imports no parser, database, MCP, UI or Cloudflare code.
Run `pnpm test:arch` before opening a PR that touches package boundaries.

## Work Intake

Every code change starts as a backlog issue. If the work is not tracked, open or update an
issue first with acceptance criteria and a test plan. Before editing, read the issue's full
comment history:

```bash
gh issue view <issue-number> --repo burakdede/lorepack --comments
```

Move the board item to `In progress`, work on a branch, and post exactly one handoff
comment when the session ends, as described in `AGENTS.md`.

Issues labelled `good first issue` are bounded starter tasks, often research spikes or
small documentation fixes. A blocker on one of those issues still applies: do not pull
post-v0.1 work into v0.1 just because the label exists.

## Test Categories

Choose the smallest set that proves the change, then run the full gate before review.

| Category | Use when | Command |
|---|---|---|
| Unit | Pure logic, schemas, hashing, ranking, parsing helpers | `pnpm test` or a focused `vitest run` |
| Integration | Real filesystem, SQLite, parser fixtures, build artifacts | `pnpm test` |
| End-to-end | User-visible CLI behaviour or output contracts | `pnpm acceptance` |
| Contract | Shared runtime, MCP, SDK or adapter behaviour | `vitest run --project contract` or package-specific contract tests |
| Determinism | Build identity, source enumeration, canonical bytes | Tests using `checkDeterminism` from `@lorepack/test-support` |
| Cross-platform | Paths, processes, locks, SQLite, shell behaviour | CI matrix on macOS, Windows and Linux |
| Security | Path traversal, symlink escape, SQL bypass, secret leakage | Focused security tests plus `pnpm acceptance` where user-facing |
| Manual | Browser/client trust prompts or UX that cannot be automated honestly | Record the checklist in `docs/` |

Bug fixes start with a failing test that reproduces the bug.

## Acceptance Scenarios

If your change alters what a person sees, add an acceptance scenario: a new command, flag,
output shape, error, or documented guarantee belongs in `tools/acceptance/src/scenarios/`.

Then regenerate and commit the checklist:

```bash
pnpm acceptance:docs
```

If a scenario cannot be automated honestly, add it as `mode: 'manual'` instead of leaving
it invisible.

## Fixture Workflow

Fixtures are source-of-truth test inputs. Do not update them just to make a diff green.

Use this flow:

1. Run the failing test without changing fixtures.
2. Read the failure and confirm the new output is the intended behaviour.
3. Update the fixture using the test's documented update path, usually
   `UPDATE_FIXTURES=1 <test command>`.
4. Inspect the fixture diff by hand.
5. Run the test again without `UPDATE_FIXTURES`.

Generated public docs are similar: run the generator, inspect the diff, and commit both
the code and generated file. Examples include `pnpm acceptance:docs`,
`pnpm cli:docs`, `pnpm schemas:generate`, `pnpm docs:capture` and `pnpm demo:readme`.

## Hard Rules And Checks

| Rule | Why it exists | Enforced by |
|---|---|---|
| Dependency direction and `core` isolation | Keeps ports and adapters real | `pnpm test:arch` |
| No native dependencies or install scripts | Protects the zero-surprise first run | `pnpm check:no-native`, clean-install CI |
| Deterministic build identity | Same canonical inputs must produce the same build ID | Determinism tests and acceptance gates |
| Provenance on every model-facing result | Results without a `SourceLocator` are bugs | Runtime contract tests, MCP/HTTP contract tests |
| Model-facing tools are read-only | AI clients may not build, deploy, edit files or execute commands | Runtime, MCP and security tests |
| No invented conflict claims | Ranking hints are user-declared, never truth detection | `pnpm check:no-conflict-claims` |
| No em dash | Project style and model-output hygiene | `pnpm check:no-em-dash`, commit hygiene CI |
| Templates keep triage fields | Bug reports need platform, Node and doctor output | `pnpm check:templates` |
| Apache-2.0 package policy | Published packages must match repository license | `pnpm check:license-policy` |

## Dependencies

Before adding a dependency, check maintenance, current release, license, install weight,
native code, post-install scripts and CVEs. Record the rationale in
[`docs/architecture/dependencies.md`](docs/architecture/dependencies.md). Do not add
native add-ons, post-install scripts, an ORM, a monorepo build orchestrator or a plugin
framework unless a measured requirement forces it.

## Changesets And Versions

Lorepack uses Changesets for release notes and package versioning.

- Add a changeset when a public package, CLI contract, protocol schema or documented
  behaviour changes.
- Skip changesets for tests, docs-only edits that do not describe new behaviour, internal
  refactors and repo tooling.
- Keep changeset prose user-facing: what changed and why it matters.

## Commit And PR Rules

Use short imperative commit subjects, no more than 72 characters. Add a body only when the
why is not obvious. Do not include AI attribution in commit messages, PR titles, PR bodies,
branch names or issue comments, except the `agent:` field in the required handoff block.

Before pushing:

```bash
git fetch origin
git rebase origin/main
pnpm verify
```

Open one PR per issue where practical. Link the issue, describe what changed in one
paragraph, and list exact verification commands with platform results.

## Review And Merge Policy

The repository owner is the maintainer and has final release authority for v0.1. Maintainers
may request changes, narrow scope, close PRs that do not fit the backlog, or defer work to a
later phase. A PR is mergeable only when:

- The issue acceptance criteria are satisfied.
- The PR is rebased on `origin/main`.
- Required CI checks are green.
- Documentation and generated artifacts are current.
- The branch contains no AI attribution.

`main` is PR-only. Branch protection is documented in `AGENTS.md`: pull requests are
required, linear history is enforced, and required status checks must pass.

## License Policy

Lorepack is Apache-2.0. The root [`LICENSE`](LICENSE) is the repository-level notice for
source files, documentation and package contents unless a file says otherwise.

Do not add per-file headers by default. Add one only when importing third-party source that
requires its own notice, and keep that notice with the file. If a dependency or imported
source requires a `NOTICE` file, add `NOTICE` at the repository root and document the reason
in `docs/architecture/dependencies.md`.

Every package manifest must declare `"license": "Apache-2.0"`. `pnpm check:license-policy`
enforces that policy.

## Code Of Conduct And Security

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security
issues privately through [GitHub Security Advisories](https://github.com/burakdede/lorepack/security/advisories/new)
or by email as described in [SECURITY.md](SECURITY.md).
