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
| Local write surface | `lore dev` host process | Browser origins | Register writes only when supplied by host, and only loopback origins may call them |
| Remote Worker runtime | Active projected build and D1/R2 bindings | Internet clients | Authenticate before reading build data |
| Deployment control plane | Local CLI and Wrangler credentials | Remote platform state | Deployment writes are CLI-only, never model-facing |

## Threats And Mitigations

| Threat | Mitigation | Verification |
|---|---|---|
| Path traversal reads host files | Runtime source reads resolve artifact IDs in the catalog, not filesystem paths | `packages/cli/test/security.e2e.test.ts`, `pnpm test:security` |
| Symlink escape during discovery | Discovery rejects symlinks escaping the source root | `packages/compiler/test/discover.test.ts` |
| Malformed archives, XML or PDFs crash or expand unboundedly | Parser caps and DOCTYPE rejection fail safely with warnings or typed errors | `packages/parsers/test/*.test.ts` |
| SQL injection reaches catalog or filesystem | One `SELECT` statement, one table authorizer, no filesystem functions, worker deadline | `packages/cli/test/security.e2e.test.ts` |
| Oversized request or response exhausts memory | Request size caps and export/context budgets bound runtime payloads | `packages/runtime/test/http.test.ts`, export tests |
| Cross-origin browser writes activate or rollback a build | Local action routes are absent unless supplied and reject non-loopback origins | `packages/runtime/test/http.test.ts` |
| Remote auth bypass exposes a deployed build | Worker authorization runs before route handling and accepts only valid Lore runtime tokens or configured Access JWTs | `packages/deploy-cloudflare/test/*auth*.test.ts` |
| Secrets appear in manifests, logs or protocol errors | Manifest validation and shared redaction renderers remove secret values and token shapes | `packages/compiler/test/validate.test.ts`, runtime and Worker tests |
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
