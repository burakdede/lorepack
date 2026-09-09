# v0.1 Delivered-Epic Reliability Audit

Date: 2026-09-09

Issue: [#347](https://github.com/burakdede/lorepack/issues/347)

This is the scope and evidence plan for the reliability audit of delivered P0 through P7
work. A green aggregate suite is a baseline, not proof that every failure boundary has been
exercised. Confirmed defects get a focused issue and a separate pull request with a failing
reproduction before the fix.

## Baseline

| Evidence | Result |
|---|---|
| `main` revision | `49413ce` |
| Local `mise exec -- pnpm verify` | 2,001 passed, 2 skipped |
| Main CI | Run `34357052016`, passed on `49413ce` |
| Phase gates | Run `34357052038`, all eight phase jobs passed |
| Production dependency audit | No known vulnerabilities |
| Secret scan | Gitleaks found no leaks |

The baseline covers the repository's formatter, linter, type checker, architecture rules,
unit and integration tests, security suite, clean-install checks, documentation checks,
schema checks, acceptance documentation and README demo. The rows below identify the
direct evidence for each delivered boundary and the additional reliability questions still
requiring review.

## Confirmed findings and fixes

| Finding | Evidence | Resolution |
|---|---|---|
| Duplicate Lorepack archive members were collapsed by filename and could pass verification | Regression in `packages/backend-local/test/archive.test.ts`; the pre-fix check resolved `ok: true` with a tampered duplicate | Fixed in [#350](https://github.com/burakdede/lorepack/pull/350), merged as `c7aa6e2` |
| Local object-store paths accepted traversal-shaped hashes | Regression in `packages/backend-local/test/storage.test.ts`; the pre-fix read reached a sentinel outside the object root | Fixed in [#352](https://github.com/burakdede/lorepack/pull/352), merged as `c87fd29` |
| Duplicate XLSX ZIP parts were silently selected by archive order | Regression in `packages/parsers/test/xlsx.test.ts`; the pre-fix parser accepted a duplicated `xl/workbook.xml` | Fixed in [#354](https://github.com/burakdede/lorepack/pull/354), merged as `bcf8f35` |
| Windows verification timed out when process-heavy projects ran concurrently | Post-merge CI `34346328504` failed 10 tests after 505.75 seconds, including MCP stdio, `lore serve`, client verification and Cloudflare target tests | Fixed in [#356](https://github.com/burakdede/lorepack/pull/356), merged as `d5c5828`; post-fix Windows test and acceptance phases passed |
| Serving startup leaked the local backend when setup or port binding failed | Regression in `packages/cli/test/serving-startup.test.ts`; an injected startup failure previously returned without calling backend cleanup | Fixed in [#359](https://github.com/burakdede/lorepack/pull/359), merged as `49413ce`; post-merge cross-platform CI and all phase gates passed |

The five findings above were fixed in separate issue-linked pull requests. The merged
revision's full CI and phase gates are the current evidence that the fixes did not regress
the delivered matrix.

## Delivered scope and evidence

| Delivered epic | Boundaries under review | Direct evidence | Audit status |
|---|---|---|---|
| P0, core foundation | Errors, canonical data, hashing, configuration, atomic files, locks and progress | `packages/core/test`, `tools/arch/test`, schema checks and the phase 0 gate | Baseline covered; review cancellation and cleanup invariants |
| P1, lifecycle vertical slice | Discovery, ignore rules, path safety, parsers, build identity, object storage, sealing, activation, rollback and CLI verbs | `packages/compiler/test`, `packages/parsers/test`, `packages/backend-local/test`, `packages/cli/test`, acceptance scenarios and phase 1 gate | Four boundary findings fixed; review malformed input and interrupted builds |
| P2, runtime and AI interfaces | Local runtime, ranking, context budgets, provenance, freshness, REST, MCP stdio, Streamable HTTP, export and SDK | `packages/runtime/test`, `packages/mcp/test`, `packages/sdk/test`, `tools/contract/test`, `packages/cli/test`, acceptance scenarios and phase 2 gate | Baseline covered; review mixed-build and bounded-output behavior |
| P3, two-command local product | `lore dev`, watcher behavior, configuration resolution, client connection plans and local serving | `packages/cli/test`, `packages/connect-clients/test`, acceptance scenarios and phase 3 gate | Windows process contention and serving startup cleanup fixed; review process shutdown and editor-save races |
| P4, Studio inspector | HTTP-only data access, five routes, plan-and-confirm writes, keyboard access, contrast and bundle budget | `apps/studio/test`, `tools/studio-e2e`, runtime HTTP tests, acceptance scenarios and phase 4 gate | Baseline covered; review stale UI state and destructive-action confirmation |
| P5, mixed artifacts and tables | HTML, PDF, DOCX, CSV and XLSX parsing, tables, read-only SQL, rules, ranking and client adapters | `packages/parsers/test`, `packages/backend-local/test`, `packages/runtime/test`, `packages/connect-clients/test`, security tests, acceptance scenarios and phase 5 gate | XLSX duplicate-part finding fixed; review malformed and oversized artifact behavior |
| P6, Cloudflare projection | Target receipts, capability checks, Worker routes, D1 and R2 projection, candidate verification, atomic activation, rollback and resume | `packages/deploy-cloudflare/test`, `tools/acceptance/test`, credentialed Cloudflare CI lane and phase 6 gate | CI covered; local credentialed reproduction remains environment-dependent |
| P7, release hardening | Supply chain, release policy, SBOM, package closure, compatibility evidence and post-publish smoke | `tools/arch/test`, release dry run `34290768745`, `docs/compatibility/v0.1-success-matrix.md`, `public-registry-smoke.yml` and phase 7 gate | Dry run covered; real publish and public registry evidence pending |

## Adversarial review checklist

Each item must end as direct test evidence, a confirmed defect with a child issue, or an
explicit external blocker.

| Risk | Required observation |
|---|---|
| Malformed documents and archives | Build fails with a typed diagnostic, leaves no active corruption and does not ingest executable content |
| Oversized inputs and responses | The documented envelope is enforced, output stays bounded and the failure identifies the limit |
| Path traversal and symlink escape | No source or output operation escapes the project or target namespace |
| Cancellation | A real process interruption leaves the active build and committed build history unchanged |
| Concurrent reads and activation | In-flight requests finish on their captured build and later requests see one complete build |
| SQL boundary | Injection, multi-statement, write and unknown-table attempts are rejected without leaking database details |
| Provenance | Search, context, export, source reads and table rows preserve complete locators |
| Archive integrity | Pack and unpack preserve checksums, required members and deterministic content |
| Retry and resume | Transient transfer failures recover without duplicate corruption; resume does not re-upload verified state |
| Clean installation | The published package path requires no native add-on, install hook, model, account or compiler toolchain |

## Known unverified or external evidence

- The real-artifact benchmark in [#332](https://github.com/burakdede/lorepack/issues/332) needs
  an approved, license-compatible corpus. Generated fixtures cannot substitute for it.
- The stable `v0.1.0` publish and public-registry smoke are acceptance work in [#102](https://github.com/burakdede/lorepack/issues/102)
  and require explicit authorization because they create a tag, GitHub release and npm
  publications.
- The current three-client trust-prompt refresh remains incomplete because VS Code is not
  installed in the audit environment. Existing dated client records remain documented as
  historical evidence.
- Credentialed Cloudflare behavior is exercised by the CI acceptance lane. A local run
  without the required account is not equivalent evidence and must remain visibly skipped.

## Audit rule

Do not close this audit because the baseline is green. Close it only when every row has
direct evidence or an explicit blocker, and each confirmed implementation defect has been
fixed and verified through its own small pull request.
