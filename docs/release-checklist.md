# Release Checklist

This checklist is for the person dispatching `.github/workflows/release.yml`.

## Before Dispatch

- Confirm the release issue links the PRs being shipped and every handoff is current.
- Confirm the generated package changelogs and [`v0.1 upgrade notes`](compatibility/v0.1-upgrade.md)
  are present in the release dry-run artifact and release notes.
- Keep release issue `#102` open until the publish and post-publish evidence are complete.
- Confirm `main` is the intended release commit and all required checks are green there.
- Confirm npm Trusted Publishing is configured for `@lorepack/cli` with GitHub Actions
  organization `burakdede`, repository `lorepack`, workflow `release.yml` and environment
  `npm-release`, with **Allow npm dist-tag** enabled.
- Confirm the `npm-release` GitHub environment still requires a reviewer and accepts only
  `main` (`gh api repos/burakdede/lorepack/environments/npm-release`).
- Before the first release, create `@lorepack/cli` once through npm staged publishing so its
  package settings exist. The real workflow runs a read-only registry preflight and stops if
  the package is still missing.
- Confirm the publisher is allowed to run direct `npm publish` and manage the `next` or `latest`
  dist tag. Do not add an `NPM_TOKEN` secret, and confirm `gh secret list` shows none.
- Confirm the performance report for issue #101 is green before a stable `latest` release.
- Confirm the v0.1 success matrix in
  [`compatibility/v0.1-success-matrix.md`](compatibility/v0.1-success-matrix.md) is current.
- Confirm the release has a Changesets entry unless the PR was intentionally marked
  `[no release]`.

## Dry Run

1. Dispatch `Release` with `dry_run: true`.
2. Use `channel: next` for a release candidate and `channel: latest` for a stable release.
3. Paste the issue #101 performance report URL for a stable release.
4. Download the `release-artifacts` artifact.
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

A real release is two dispatches from `main`, so that the tag, the package `gitHead` and
the npm provenance all name the same commit (see
[`release-supply-chain.md`](architecture/release-supply-chain.md#release-artifacts)).

1. Dispatch `Release` from `main` with the same version and channel, `dry_run: false` and
   `resume_existing: false`. The `release PR` job versions the packages, opens the release PR,
   waits for its CI and merges it. It publishes nothing.
2. When `main` is at the merged release commit and its checks are green, dispatch `Release`
   from `main` again with `dry_run: false` and `resume_existing: true`.
3. Approve the `npm-release` deployment when GitHub asks. Only then does the `publish to npm`
   job run.
4. The workflow publishes `@lorepack/cli` through npm Trusted Publishing with provenance and,
   only if that succeeded, tags `vX.Y.Z` and creates the GitHub release. A failed publish
   leaves no tag and no release. Re-running the same dispatch is safe: an already-published
   version is accepted only if its registry integrity equals the new tarball, and its dist-tag
   is then moved to the requested channel.
5. Verify the GitHub release contains the SBOM, dependency-health report and `.lorepack`
   example artifact.
6. Install from npm using the selected channel and run the smoke commands again.

The `Public registry smoke` workflow runs this public install check automatically after a
GitHub release is published. It verifies registry signatures with `npm audit signatures`,
asserts that the package `gitHead` and its SLSA provenance both name the release tag's commit
(`scripts/check-registry-provenance.mjs`), and installs the CLI with npm to check it carries no
native add-on. It can also be rerun manually with the published version, and its matrix summary
records the version, runner platform and Node version that were tested.

## Rollback

If a release is bad:

1. Move the affected npm dist tag back to the previous known-good version.
2. Deprecate the bad package versions with `npm deprecate`.
3. Open a blocking issue and link it from the GitHub release notes.
4. Tell users to activate or roll back to the previous immutable build. For Cloudflare targets,
   roll back the active deployment pointer rather than re-projecting.
