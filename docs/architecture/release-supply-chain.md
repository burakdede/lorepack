# Release Supply Chain

Issue `#99` owns the v0.1 supply-chain release gate.

## Always-on checks

`pnpm check:supply-chain` verifies:

- production `pnpm audit --prod --audit-level moderate` is clean;
- `pnpm licenses list --prod --json` and every direct dependency report contain only
  allowlisted licences;
- the public CLI has `publishConfig.provenance: true`;
- npm provenance metadata is recorded for production direct dependencies where available, and
  missing attestations are named;
- every direct dependency has a rationale in [`dependencies.md`](dependencies.md);
- `reports/dependency-health.json` and `reports/sbom.cyclonedx.json` are current.

Update the committed reports with:

```bash
pnpm supply-chain:report
```

## What npm users install

`@lorepack/cli` is published with its production dependency tree **bundled in the tarball**
(`bundleDependencies`), so `npm install @lorepack/cli` installs exactly the tree CI tested and
resolves nothing.

Without it, npm users got a different tree from the one the workspace tests (#603):

- `pdfjs-dist` declares `@napi-rs/canvas` as an optional dependency. The workspace removes it
  with a pnpm override, but pnpm overrides are not part of a published manifest, so npm installed
  27 MB of native Skia and pdfjs `dlopen`ed it on every PDF parse. That breaks invariant 7.
- The `mammoth>argparse` and `@xmldom/xmldom` overrides did not ship either, so users' `npm audit
  --omit=dev` reported 4 moderate findings (GHSA-hp3w-g68c-fv3c through `argparse@1.0.10`).
- 17 packages resolved to versions CI never ran, including a second copy of `zod`.

`scripts/pack-cli.mjs` builds the tarball. It runs `pnpm deploy --prod` for the CLI from a
copy of the workspace (lockfile, workspace configuration and manifests), with injected workspace
packages and a hoisted `node_modules`, so the frozen lockfile and every workspace override
apply. It then sets `bundleDependencies` to the CLI's dependencies, drops the workspace-only
`devDependencies`, and runs `npm pack`. The injected deploy matters: `pnpm deploy --legacy`
re-resolved the ranges and drifted 17 packages from the lockfile when tried.

`scripts/check-packed-cli.mjs` is the gate. It installs the tarball with **npm** into an empty
directory and fails on any `*.node` file or `@napi-rs/*` package, on any difference from the
CLI's production tree in the frozen lockfile (an optional peer the workspace happens to resolve,
such as `supports-color` for `debug`, is excused), on a PDF build and search with the installed
CLI that `dlopen`s anything, and on any `npm audit --omit=dev` finding. It runs:

- in the `packed install` CI job on Ubuntu, Windows and macOS (`pnpm check:packed-cli`);
- in the release workflow, against the exact tarball that is then published;
- in `Public registry smoke`, against the published version (`--spec`), without the lockfile
  comparison because that checkout need not match the release.

### Alternatives rejected

- **A published `npm-shrinkwrap.json`.** npm 11 honours one inside a dependency tarball, but npm
  12 (released 2026-09-30) no longer reads or writes `npm-shrinkwrap.json` at all and its
  release notes point publishers at `bundleDependencies` instead. A shrinkwrap would protect
  users only until they upgrade npm. Verified 2026-10-10: npm 12.2.0 also refuses to pack the
  file even when `files` lists it. A shrinkwrap also cannot express the argparse override: npm
  treats `argparse@2.0.1` under `mammoth` (which asks for `~1.0.3`) as an invalid edge.
- **Bundling `pdfjs-dist` into `public-entry.js` with esbuild.** It removes the optional
  dependency but hides pdfjs from users' `npm audit` and leaves the other 17 drifts.
- **Documenting `--omit=optional`.** Fragile, and it does nothing for the argparse override or
  version drift.

The cost is a larger tarball (18 MB packed, 81 MB unpacked, about 4,900 files, measured
2026-10-10), which users download once instead of resolving 145 packages. `npm audit` still
covers the bundled packages: npm reads them from `node_modules` like any other.

## Provenance

The public `@lorepack/cli` package sets:

```json
{
  "publishConfig": {
    "access": "public",
    "provenance": true
  }
}
```

The release workflow grants `id-token: write`, uses `actions/setup-node` with the npm registry,
and publishes the CLI through `scripts/publish-packages.mjs` using npm Trusted Publishing.
The publisher checks the registry first so a retry skips versions already published, then invokes
`npm publish <tarball>` for every missing version, on the tarball that was packed and checked
rather than on the package directory, which would re-pack it without its bundled tree. npm obtains the provenance statement from GitHub's OIDC
identity, so the workflow has no long-lived npm publish token.

Before the first real release, configure Trusted Publishing in the npm settings for
`@lorepack/cli`. Select GitHub Actions and set organization `burakdede`, repository
`lorepack`, workflow filename `release.yml`, and permission for direct `npm publish`. The
workflow uses the `next` or `latest` dist tag, so allow dist-tag management when npm asks for
that permission. After the publisher is verified, set the package to require two-factor
authentication and disallow token-based publishing, then revoke obsolete automation tokens.

The CLI package must exist in the npm registry before its Trusted Publisher can be configured.
Bootstrap it once through npm staged publishing, then approve the staged placeholder with 2FA.
The real release runs `scripts/preflight-npm-packages.mjs` before creating a release commit or
GitHub release and reports a missing package without publishing anything.

For dependencies, the health report reads npm registry `dist.attestations.provenance` metadata
for exact production direct dependencies. Missing attestations are reported by package name, not
silently ignored.

## Versioning Policy

Changesets owns package version changes and package changelog entries. The first release versions
only `@lorepack/cli`. Internal packages remain workspace implementation details and are bundled
into that CLI. A later public package gets its own Changesets entry and compatibility policy
after its API and audience are documented.

Package versions do not define build compatibility on their own:

- `formatVersion` is the sealed `.lorepack` archive contract. A breaking archive change raises
  `formatVersion`, even if package versions also move.
- `schemaVersion` is the catalog schema inside a build. A new package can read an older schema
  only when code explicitly supports that schema.
- package versions describe npm artifacts and changelogs. They are the delivery vehicle, not the
  build identity or archive identity.

Release candidates publish to the npm `next` dist tag. Stable releases publish to `latest`.

## Release artifacts

The release workflow is manual and dry-runnable. It requires the target version, npm channel
(`latest` or `next`), a `dry_run` flag and, for stable publishing, the green reference-machine
performance report URL from issue #101. Before any publish-side effect, it verifies that the
required CI, clean-install, security, Cloudflare, Studio and benchmark check-runs completed
successfully for the exact release commit.

A dry run performs the same install, verification, Changesets versioning, build, SBOM
generation, example package creation, CLI npm tarball packing (`scripts/pack-cli.mjs`) and the
packed-install check (`scripts/check-packed-cli.mjs`), then uploads the artifacts without
committing, tagging, creating a GitHub release or publishing to npm.

A real release then commits the version changes, tags `vX.Y.Z`, creates the GitHub release, and
publishes the CLI with npm provenance through `scripts/publish-packages.mjs --tag <channel>`.
If a retry finds an existing release from an earlier failed recovery, it retargets that release
only when the old target is an ancestor of the current green commit and recovery mode is enabled.
The `Public registry smoke` workflow then installs the published CLI from npm on Ubuntu,
Windows and macOS and exercises the shipped binary without installing the workspace.

The GitHub release receives:

- `reports/dependency-health.json`;
- `reports/sbom.cyclonedx.json`;
- `examples/product-research/product-research.lorepack`.

## Release Checklist

The operational checklist lives in [`../release-checklist.md`](../release-checklist.md). It
covers dry-run execution, client trust prompts, Cloudflare acceptance, the demo script,
release-candidate publishing on `next`, stable publishing on `latest`, and post-release smoke
checks.

## Rollback and Deprecation

A bad release is handled by pointer and registry actions, not by recompiling a build:

1. Move npm dist tags back to the last known-good version with `npm dist-tag add`.
2. Deprecate the bad package versions with `npm deprecate`, naming the replacement version.
3. Mark the GitHub release as problematic and link the fix or rollback PR.
4. If a bad `.lorepack` example was attached, attach a corrected artifact to the follow-up
   release instead of mutating build identity.
5. Use `lorepack activate` or `lorepack rollback` for affected local projects and Cloudflare target
   activation rollback for projected runtimes.

## SBOM

The committed SBOM is CycloneDX 1.5 JSON at [`../../reports/sbom.cyclonedx.json`](../../reports/sbom.cyclonedx.json).
It is generated from pnpm's resolved dependency inventory and direct dependency metadata. It is
attached by the release workflow together with the dependency-health report.

`npm sbom` was evaluated on 2026-08-14 and rejected for this workspace because it validates an
npm-style physical `node_modules` tree. Against pnpm's content-addressed store links it reports
hundreds of missing or invalid package edges. The SBOM therefore uses pnpm's own resolved
inventory rather than adding a separate generator dependency.

## Dependency health

[`../../reports/dependency-health.json`](../../reports/dependency-health.json) records, for
each direct dependency:

- pinned specifiers and workspace references;
- latest version and latest registry release date;
- pinned publish date when the specifier is exact;
- days since the latest release, measured against the report date;
- production licence;
- npm provenance attestation status for production direct dependencies;
- current or stale-warning status.

The stale threshold is 548 days. A stale direct dependency does not fail automatically, because
stable specification packages can be quiet for good reasons. It must have a named owner and a
recorded decision in [`dependencies.md`](dependencies.md).
