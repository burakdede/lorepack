# Release Checklist

This checklist is for the person dispatching `.github/workflows/release.yml`.

## Before Dispatch

- Confirm the release issue links the PRs being shipped and every handoff is current.
- Confirm the generated package changelogs and [`v0.1 upgrade notes`](compatibility/v0.1-upgrade.md)
  are present in the release dry-run artifact and release notes.
- Keep release issue `#102` open until the publish and post-publish evidence are complete.
- Confirm `main` is the intended release commit and all required checks are green there.
- Confirm npm Trusted Publishing is configured for `@lorepack/cli` with GitHub Actions
  organization `burakdede`, repository `lorepack`, and workflow `release.yml`.
- Before the first release, create `@lorepack/cli` once through npm staged publishing so its
  package settings exist. The real workflow runs a read-only registry preflight and stops if
  the package is still missing.
- Confirm the publisher is allowed to run direct `npm publish` and manage the `next` or `latest`
  dist tag. Do not add an `NPM_TOKEN` secret.
- Confirm the performance report for issue #101 is green before a stable `latest` release.
- Confirm the v0.1 success matrix in
  [`compatibility/v0.1-success-matrix.md`](compatibility/v0.1-success-matrix.md) is current.
- Confirm the release has a Changesets entry unless the PR was intentionally marked
  `[no release]`.

## Dry Run

1. Dispatch `Release` with `dry_run: true`.
2. Use `channel: next` for a release candidate and `channel: latest` for a stable release.
3. Paste the issue #101 performance report URL for a stable release.
4. Download the `release-dry-run` artifact.
5. Inspect the npm tarballs under `release-artifacts/npm`. Each must bundle its dependency
   tree, and the run must show `check:packed-cli: clean` for it: no native add-on, the tested
   production tree, and a clean `npm audit --omit=dev`.
6. Inspect `reports/sbom.cyclonedx.json` and `reports/dependency-health.json`.
7. Build and open `examples/product-research/product-research.lorepack` with the current CLI.

## Manual Verification

- Run the README demo script from a clean checkout and compare it with
  [`demo-transcript.md`](demo-transcript.md).
- Verify client trust prompts for Codex, Claude Code and VS Code using the integration docs.
- Run the Cloudflare acceptance checklist in
  [`integrations/cloudflare-testing.md`](integrations/cloudflare-testing.md) against the
  release candidate.
- Run `lorepack init`, `lorepack build`, `lorepack search rollback`, `lorepack pack`, `lorepack serve` and
  `lorepack mcp` from the dry-run tarball install.

## Real Release

1. Dispatch `Release` with the same version and channel, with `dry_run: false`.
2. Wait for the workflow to commit the version changes, tag `vX.Y.Z`, create the GitHub
   release and publish `@lorepack/cli` through npm Trusted Publishing with provenance.
3. Verify the GitHub release contains the SBOM, dependency-health report and `.lorepack`
   example artifact.
4. Verify npm shows provenance for `@lorepack/cli`.
5. Install from npm using the selected channel and run the smoke commands again.

The `Public registry smoke` workflow runs this public install check automatically after a
GitHub release is published. It can also be rerun manually with the published version, and
its matrix summary records the version, runner platform and Node version that were tested.

## Rollback

If a release is bad:

1. Move the affected npm dist tag back to the previous known-good version.
2. Deprecate the bad package versions with `npm deprecate`.
3. Open a blocking issue and link it from the GitHub release notes.
4. Tell users to activate or roll back to the previous immutable build. For Cloudflare targets,
   roll back the active deployment pointer rather than re-projecting.
