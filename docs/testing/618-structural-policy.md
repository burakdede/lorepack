# Structural workflow policy verification

The release and verify-parity gates parse workflow YAML using the existing CLI
`yaml` dependency. Commented steps cannot satisfy policy. Required CI commands
must be standalone, unconditional and non-optional at both step and job level.
The local verify chain accepts only exact pnpm commands joined by `&&`.

The release gate requires an active check loop in the build job and rejects
long-lived credentials in the publish job or inherited workflow environment.
The existing release structure rules enforce protected OIDC publishing and the
publish dependency before tags or GitHub release creation. An echo-only Trusted
Publishing step supplies no evidence and is no longer counted as enforcement.
These checks enforce the repository's workflow shape; they do not interpret
arbitrary shell programs or prove a performance report's contents.

Verified on macOS with Node 24.21.0 and pnpm 11.18.0 on 2026-10-19:

- Against unchanged checkers, the new regression file produced 14 failures and
  two passes. Both reported bypasses incorrectly exited successfully.
- After the fix, `pnpm exec vitest run --project arch
  tools/arch/test/workflow-policy.test.ts tools/arch/test/release-policy.test.ts`
  passed all 45 tests. The original release-policy workload remains unchanged.
- `node scripts/check-release-policy.mjs` enforced 12 required release checks.
- `node scripts/check-verify-parity.mjs` confirmed 27 checks in verify and CI.

The scratch parity fixture executes an unchanged copy of the checker from the
scratch root, so it reads the mutated workflow even before the implementation
has a configurable root. Directory junctions resolve existing workspace YAML
without installing dependencies into each fixture. Windows and Linux results
remain pending native CI.
