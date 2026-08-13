# Pre-release Security Review

Date: 2026-08-14

Issue: `#98`

Status: checked in as the v0.1 pre-release review record. Update this file on any later
security-affecting change before release.

## Checklist

| Check | Evidence | Result |
|---|---|---|
| Path traversal and symlink escape | `packages/cli/test/security.e2e.test.ts`, `packages/compiler/test/discover.test.ts` | Covered |
| Malformed PDF and Office inputs | `packages/parsers/test/pdf.test.ts`, `packages/parsers/test/docx.test.ts`, `packages/parsers/test/xlsx.test.ts` | Covered |
| SQL injection and multi-statement attempts | `packages/cli/test/security.e2e.test.ts`, `packages/backend-local/test/sql-surface.test.ts` | Covered |
| Oversized requests and responses | `packages/runtime/test/http.test.ts`, export/context budget tests | Covered |
| Localhost Origin validation | `packages/runtime/test/http.test.ts` | Covered |
| Remote auth bypass | `packages/deploy-cloudflare/test/runtime-auth.test.ts`, `packages/deploy-cloudflare/test/access-auth.test.ts`, `packages/deploy-cloudflare/test/worker-app.test.ts` | Covered |
| Secret exclusion from manifests and logs | `packages/compiler/test/validate.test.ts`, `packages/core/test/errors.test.ts` | Covered |
| Malicious config redaction | `packages/cli/test/config-resolve.test.ts` | Covered |
| No telemetry or source egress in core build path | `tools/security/test/privacy-defaults.test.ts` | Covered |
| Model-facing tools are read-only | `tools/contract/test/mcp.test.ts` | Covered |

## Commands To Run For Sign-off

```bash
pnpm test:security
pnpm verify
```

The live Cloudflare smoke remains a separate credentialed gate:

```bash
pnpm build
cd tools/acceptance
pnpm exec vitest run test/cloudflare-smoke.test.ts test/cloudflare-testing.test.ts
```

## Verification Results

| Date | Command | Result |
|---|---|---|
| 2026-08-14 | `mise exec -- pnpm test:security` | Passed: 2 files, 14 tests |
| 2026-08-14 | `mise exec -- pnpm verify` | Passed through `pnpm test:security`; then failed at `check:sources-tracked` because the new files were not staged yet |
| 2026-08-14 | `mise exec -- pnpm check:sources-tracked && mise exec -- pnpm check:docs-images && mise exec -- pnpm check:docs-links && mise exec -- pnpm check:templates && mise exec -- pnpm check:license-policy && mise exec -- pnpm check:verify-parity && mise exec -- pnpm schemas:check && mise exec -- pnpm probe:fts5 && mise exec -- pnpm acceptance:docs:check && mise exec -- pnpm cli:docs:check && mise exec -- pnpm demo:readme:check` | Passed after staging the new files |

## Notes

Local runtime authentication is intentionally absent. The local server is a loopback process
started by the user, and local writes are protected by route registration and Origin checks.
Remote reads are authenticated at the Worker boundary.

The privacy-default test blocks `fetch` and Node socket connection attempts. It does not prove
native dependencies cannot open sockets by another route; invariant 7 and `pnpm check:no-native`
keep native add-ons out of the default install.
