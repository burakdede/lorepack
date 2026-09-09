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
| `main` revision | `6f50835` |
| Local `mise exec -- pnpm verify` | 2,008 passed, 2 skipped on macOS arm64 with Node 24.18.1 |
| Main CI | Run `34402158002`, post-merge verification for `6f50835` |
| Phase gates | Run `34402158015`, post-merge phase verification for `6f50835` |
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
| Seal permission failures were treated as duplicate destinations | Regression in `packages/backend-local/test/storage.test.ts`; an injected `EPERM` or `EACCES` during sealing could report success and let the build proceed without a sealed directory | Fixed in [#362](https://github.com/burakdede/lorepack/pull/362), merged as `26f72b9`; post-merge cross-platform CI and all phase gates passed |
| The real-process cancellation test required a nonzero Windows exit code | PR [#366](https://github.com/burakdede/lorepack/pull/366) initially exposed that Node reports the Windows hard-termination path as code 0, even though the process was interrupted during parsing | Fixed in [#366](https://github.com/burakdede/lorepack/pull/366), merged as `8b40dd1`; Windows safety invariants and POSIX typed cancellation are now asserted separately, with post-merge CI and all phase gates passed |
| The Windows Wrangler smoke test had an insufficient per-test timeout | Post-merge CI run `34364832045` timed out the real local D1 and R2 smoke after the global 60-second Vitest limit | Fixed in [#364](https://github.com/burakdede/lorepack/pull/364), merged as `3801524`; the corrected Windows test, post-merge CI and all phase gates passed |
| Live local lock records were reclaimed solely because of age | Regression in `packages/backend-local/test/storage.test.ts`; a lock held by a live owner was reclaimed after the staleness window, and a former owner could remove a replacement lock | Fixed in [#372](https://github.com/burakdede/lorepack/pull/372), merged as `5886f08`; live owners are preserved and acquisition tokens protect replacement locks |
| Cloudflare D1 provider error 7500 was not retried | Credentialed acceptance run `34390810040` failed in the resume scenario while `lore target token cloudflare` received Cloudflare API code 7500 from remote D1 | Fixed in [#376](https://github.com/burakdede/lorepack/pull/376), merged as `cb8af60`; the bounded retry classifier now covers code 7500 and credentialed acceptance passed |

The PDF hard page-cap boundary is now directly covered by [#369](https://github.com/burakdede/lorepack/pull/369),
which merged as `1c5aa13`. A generated 5,001-page PDF must fail with the typed unsupported-format
diagnostic and split-document remediation. This closes the previously untested hard-cap branch
without changing the documented limit.

The ten findings above were fixed in separate issue-linked pull requests. The merged
revision's full CI and phase gates are the current evidence that the fixes did not regress
the delivered matrix.

The lock fix in #372 is directly covered by 33 storage tests and all 134 backend-local tests,
including live-owner preservation and replacement-lock cleanup. The Cloudflare retry fix in
#376 is directly covered by the CLI Cloudflare target regression suite and the credentialed
acceptance lane, including the resume scenario that previously failed with API code 7500.

## Delivered scope and evidence

| Delivered epic | Boundaries under review | Direct evidence | Audit status |
|---|---|---|---|
| P0, core foundation | Errors, canonical data, hashing, configuration, atomic files, locks and progress | `packages/core/test`, `tools/arch/test`, schema checks and the phase 0 gate | Direct targeted evidence passed; live-lock ownership and replacement cleanup fixed in #372 |
| P1, lifecycle vertical slice | Discovery, ignore rules, path safety, parsers, build identity, object storage, sealing, activation, rollback and CLI verbs | `packages/compiler/test`, `packages/parsers/test`, `packages/backend-local/test`, `packages/cli/test`, acceptance scenarios and phase 1 gate | Direct malformed-input, path, archive, sealing, cancellation and damaged-build evidence passed; confirmed findings fixed in #350, #352, #354, #362 and #366 |
| P2, runtime and AI interfaces | Local runtime, ranking, context budgets, provenance, freshness, REST, MCP stdio, Streamable HTTP, export and SDK | `packages/runtime/test`, `packages/mcp/test`, `packages/sdk/test`, `tools/contract/test`, `packages/cli/test`, acceptance scenarios and phase 2 gate | Direct mixed-build, bounded-output, SQL, provenance and contract evidence passed |
| P3, two-command local product | `lore dev`, watcher behavior, configuration resolution, client connection plans and local serving | `packages/cli/test`, `packages/connect-clients/test`, acceptance scenarios and phase 3 gate | Direct watcher, editor-save, shutdown, cancellation and serving evidence passed; confirmed process and startup findings fixed in #356, #359 and #364 |
| P4, Studio inspector | HTTP-only data access, five routes, plan-and-confirm writes, keyboard access, contrast and bundle budget | `apps/studio/test`, `tools/studio-e2e`, runtime HTTP tests, acceptance scenarios and phase 4 gate | Automated route, keyboard, contrast, zoom, confirmation and bundle evidence passed; human screen-reader and reduced-motion verification is tracked in #381 |
| P5, mixed artifacts and tables | HTML, PDF, DOCX, CSV and XLSX parsing, tables, read-only SQL, rules, ranking and client adapters | `packages/parsers/test`, `packages/backend-local/test`, `packages/runtime/test`, `packages/connect-clients/test`, security tests, acceptance scenarios and phase 5 gate | Direct malformed, oversized, archive-integrity, read-only SQL, table and provenance evidence passed; XLSX duplicate-part finding fixed in #354 |
| P6, Cloudflare projection | Target receipts, capability checks, Worker routes, D1 and R2 projection, candidate verification, atomic activation, rollback and resume | `packages/deploy-cloudflare/test`, `tools/acceptance/test`, credentialed Cloudflare CI lane and phase 6 gate | Direct credentialed deployment, retry, rollback and resume evidence passed; Wrangler timeout and D1 API 7500 findings fixed in #364 and #376 |
| P7, release hardening | Supply chain, release policy, SBOM, package closure, compatibility evidence and post-publish smoke | `tools/arch/test`, release dry run `34290768745`, `docs/compatibility/v0.1-success-matrix.md`, `public-registry-smoke.yml` and phase 7 gate | Dry-run and supply-chain evidence passed; real publish and public-registry smoke remain owned by #102 |

## Adversarial review checklist

Each item must end as direct test evidence, a confirmed defect with a child issue, or an
explicit external blocker.

| Risk | Required observation | Direct evidence |
|---|---|---|
| Malformed documents and archives | Build fails with a typed diagnostic, leaves no active corruption and does not ingest executable content | Parser corruption cases in `packages/parsers/test/{docx,pdf,html,markdown,text,xlsx}.test.ts`; compiler validation and damaged-build tests |
| Oversized inputs and responses | The documented envelope is enforced, output stays bounded and the failure identifies the limit | Source, artifact and file-count limits in `packages/compiler/test/discover.test.ts`; CSV, PDF and chunk limits in parser/compiler tests; context budget and SQL row/byte limits in `packages/runtime/test/context.test.ts` and `packages/backend-local/test/sql-surface.test.ts` |
| Path traversal and symlink escape | No source or output operation escapes the project or target namespace | Symlink cases in `packages/compiler/test/discover.test.ts`; object-hash validation in `packages/backend-local/test/storage.test.ts`; archive-relative path checks in `packages/backend-local/test/archive.test.ts` |
| Cancellation | A real process interruption leaves the active build and committed build history unchanged | Real process and typed cancellation cases in `packages/cli/test/cancellation.test.ts`, `packages/cli/test/async-parser.test.ts` and acceptance runner cancellation tests |
| Concurrent reads and activation | In-flight requests finish on their captured build and later requests see one complete build | Build capture, scope identity and reader-drain cases in `packages/runtime/test/runtime.test.ts` and `packages/cli/test/runtime-local.test.ts` |
| SQL boundary | Injection, multi-statement, write and unknown-table attempts are rejected without leaking database details | Tokenizer, authorizer, bounded execution and redaction cases in `packages/backend-local/test/sql-surface.test.ts`, `sqlite.test.ts` and `packages/cli/test/security.e2e.test.ts` |
| Provenance | Search, context, export, source reads and table rows preserve complete locators | Runtime, retrieval, source-read, table and MCP contract tests in `packages/runtime/test`, `packages/cli/test/retrieval.test.ts`, `table-description.test.ts`, and `tools/contract/test/mcp.test.ts` |
| Archive integrity | Pack and unpack preserve checksums, required members and deterministic content | Archive round-trip, checksum, duplicate-member and required-member cases in `packages/backend-local/test/archive.test.ts` and `packages/cli/test/pack.test.ts` |
| Retry and resume | Transient transfer failures recover without duplicate corruption; resume does not re-upload verified state | Cloudflare retry classifier and resume scenarios in `packages/cli/test/cloudflare-target.test.ts` and `tools/acceptance/test/cloudflare-smoke.test.ts`; credentialed acceptance in PR #377 run `34398631920` |
| Clean installation | The published package path requires no native add-on, install hook, model, account or compiler toolchain | Clean-install jobs for macOS, Ubuntu and Windows in PR #377 run `34398631920`; supply-chain and no-native checks in `pnpm verify` |

## Known unverified or external evidence

- The real-artifact benchmark in [#332](https://github.com/burakdede/lorepack/issues/332) needs
  an approved, license-compatible corpus. Generated fixtures cannot substitute for it.
- The stable `v0.1.0` publish and public-registry smoke are acceptance work in [#102](https://github.com/burakdede/lorepack/issues/102)
  and require explicit authorization because they create a tag, GitHub release and npm
  publications.
- The current three-client trust-prompt refresh remains incomplete because VS Code is not
  installed in the audit environment. Existing dated client records remain documented as
  historical evidence.
- Studio's screen-reader announcements and reduced-motion behavior remain manual checks in
  `docs/architecture/studio.md`; the audit environment has no signed-off human verification
  for those prompts. Issue [#381](https://github.com/burakdede/lorepack/issues/381) owns that
  verification.
- Credentialed Cloudflare behavior is exercised by the CI acceptance lane. A local run
  without the required account is not equivalent evidence and must remain visibly skipped.

## Audit rule

Do not close this audit because the baseline is green. Close it only when every row has
direct evidence or an explicit blocker, and each confirmed implementation defect has been
fixed and verified through its own small pull request.
