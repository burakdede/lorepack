# Threat Model

Date: 2026-08-14

Scope: Lorepack v0.1 local build, local runtime, model-facing MCP and REST surfaces, and the
Cloudflare remote read projection. This document describes what Lorepack protects, where trust
changes, and which threats are intentionally not solved.

## Assets

| Asset | Why it matters | Primary controls |
|---|---|---|
| Source corpus | User documents may contain private project data | Source roots, parser limits, no telemetry, read-source catalog lookup |
| Immutable builds | Runtime truth must not change under a model | Content-derived build IDs, validation before seal, activation pointer |
| Active pointer | Determines what every runtime reads | Atomic activation and rollback, local control-only writes |
| Build catalog and objects | Serve model context and source excerpts | Read-only runtime ports, locators on every result, redaction |
| Tables and SQL view | Exposes structured source data | Single-table `SELECT` gate, SQLite authorizer, worker deadline |
| Config and deployment receipts | Can contain identifiers and paths | Secret-shaped value redaction, non-secret receipts, manifest validation |
| Runtime tokens | Protect remote read deployments | Hashed storage, prefix validation, non-enumerating failures |

## Trust Boundaries

| Boundary | Trusted side | Untrusted side | Rule |
|---|---|---|---|
| Local filesystem discovery | Canonical source roots | Paths, symlinks and file names under user control | Never follow an artifact outside configured roots or into `.lore` |
| Parser input | Parser process and limits | PDF, DOCX, XLSX, CSV, HTML, Markdown and text bytes | Treat bytes as data, never execute, fetch or expand external entities |
| Build sealing | Candidate build directory | Parsed content, tables, config and warnings | Validate before recording or activation |
| Runtime REST and MCP | Immutable build projection | Client requests and model tool calls | Read only, bounded inputs, locators everywhere |
| Local HTTP server | `lorepack dev` and `lorepack serve` on loopback | Web pages in the user's browser, including DNS-rebound ones | Answer only to the `Host` names derived from the bind address, on every route |
| Local write surface | `lorepack dev` host process on a loopback bind | Browser origins, including other servers on `localhost` | Register writes only when supplied by host; a browser caller must be same-origin with the server on a loopback name; JSON bodies only; no caller-chosen output path |
| Remote Worker runtime | Active projected build and D1/R2 bindings | Internet clients | Authenticate before reading build data |
| Deployment control plane | Local CLI and Wrangler credentials | Remote platform state | Deployment writes are CLI-only, never model-facing |
| AI client configuration (`lorepack connect`) | Files in the user's home (`~/.claude.json`, `$CODEX_HOME/config.toml`, the VS Code profile) | Client configuration files inside a project directory, which arrive with the repository | Never follow a link inside the project; follow a user's own dotfile link to its target; never widen a file's mode |

## Threats And Mitigations

| Threat | Mitigation | Verification |
|---|---|---|
| Path traversal reads host files | Runtime source reads resolve artifact IDs in the catalog, not filesystem paths | `packages/cli/test/security.e2e.test.ts`, `pnpm test:security` |
| Symlink escape during discovery | Discovery rejects symlinks escaping the source root; configuration loading rejects a source root that is, or passes through, a link out of the project | `packages/compiler/test/discover.test.ts`, `packages/core/test/config.test.ts`, `packages/cli/test/security.e2e.test.ts` |
| Malformed archives, XML or PDFs crash or expand unboundedly | Parser caps and DOCTYPE rejection fail safely with warnings or typed errors | `packages/parsers/test/*.test.ts` |
| SQL injection reaches catalog or filesystem | One `SELECT` statement, one table authorizer, no filesystem functions, worker deadline | `packages/cli/test/security.e2e.test.ts` |
| A repeated or very long query multiplies FTS5 work and stalls the server or the shared D1 database | `escapeFtsQuery` in core, shared by the local and D1 catalogs, folds repeated terms into one phrase and refuses more than 64 distinct terms with a typed 400 | `packages/deploy-cloudflare/test/ranking-parity.test.ts`, `packages/cli/test/security.e2e.test.ts`, `pnpm test:security` |
| Oversized request or response exhausts memory | Request size caps and export/context budgets bound runtime payloads | `packages/runtime/test/http.test.ts`, export tests |
| DNS rebinding lets a web page read sources, tables or diagnostics from the local server | Every route, REST and `/mcp`, refuses a `Host` outside the allowlist derived from the bind address; `Origin` checks do not cover this, because a rebound page's same-origin `GET` carries no `Origin` | `packages/runtime/test/http.test.ts`, `packages/cli/test/serving.test.ts`, `tools/security/test/local-server.test.ts` |
| A host on the network activates, rolls back or packs through `lorepack dev --host 0.0.0.0` | On a non-loopback bind, `lorepack dev` registers no write route, plan or diagnostics, and the warning states that reads are unauthenticated | `packages/cli/test/dev.e2e.test.ts`, `packages/cli/test/serving.test.ts` |
| Cross-origin browser writes activate or rollback a build, or overwrite a file through pack | Local action routes are absent unless supplied; a browser `Origin` must match the request's `Host` and port, so another `localhost` port is refused; every JSON route returns `415` for a preflight-free content type; the HTTP pack schema has no `out` | `packages/runtime/test/http.test.ts`, `tools/security/test/local-server.test.ts` |
| Remote auth bypass exposes a deployed build | Worker authorization runs before route handling and accepts only valid Lore runtime tokens or configured Access JWTs | `packages/deploy-cloudflare/test/*auth*.test.ts` |
| Secrets appear in manifests, logs or protocol errors | Manifest validation and shared redaction renderers remove secret values and token shapes | `packages/compiler/test/validate.test.ts`, runtime and Worker tests |
| A repository links its client configuration to the user's secrets, so `connect` copies tokens into the project | Every project-scope configuration path is checked component by component with `lstat`; a link is refused with `LORE_E_PATH_ESCAPE` before anything is read, backed up or written. User-scope links are resolved and edited at their target | `packages/connect-clients/test/contract.ts`, `packages/connect-clients/test/config-file.test.ts`, `packages/cli/test/connect.test.ts` |
| `connect` makes a 0600 client configuration world-readable | Atomic writes copy the existing file's mode onto the replacement; new user-scope files are created 0600; backups keep the original's mode | `packages/connect-clients/test/contract.ts`, `packages/connect-clients/test/config-file.test.ts` |
| `lorepack deploy` executes a package an attacker published under a guessable name | Wrangler is resolved by Node's own algorithm for the package named `wrangler`, from the project and then from the CLI's install, and its manifest name is checked. The old relative walk to `node_modules/deploy-cloudflare/...` is gone (#580) | `packages/cli/test/wrangler.test.ts`, acceptance `packaging/the-installed-cli-finds-the-projects-wrangler` |
| Model-facing tools mutate the project | MCP tool list is exactly the documented read-only set | `tools/contract/test/mcp.test.ts` |
| Build path sends source content over the network | There is no telemetry path; the security suite blocks `fetch` and socket connects during build | `tools/security/test/privacy-defaults.test.ts` |

## Non-goals

| Non-goal | Reason |
|---|---|
| Secret scanning source content | Credential-shaped warnings are guardrails, not a scanner |
| Deciding which document is true | `authority`, `status` and `supersedes` are user-declared ranking hints |
| Preventing local users from reading their own files | Lorepack runs with the user's OS permissions |
| Protecting a loopback server from the same local user | Local auth would add a weak secret to a same-user boundary |
| OCR, images and screenshots | Out of scope for v0.1 |
| Server-side compilation on Cloudflare | Remote deployments are projections of immutable local builds |
| Multi-user tenancy | Out of scope for v0.1 |

## Release Gate

Before v0.1, security sign-off requires:

1. `pnpm test:security` green on the branch.
2. `pnpm verify` green across macOS, Windows and Linux CI.
3. Credentialed Cloudflare smoke recorded or an explicit release-manager exception.
4. [`security-review.md`](security-review.md) updated with the exact commands and dates.
