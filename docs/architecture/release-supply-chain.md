# Release Supply Chain

Issue `#99` owns the v0.1 supply-chain release gate.

## Always-on checks

`pnpm check:supply-chain` verifies:

- production `pnpm audit --prod --audit-level moderate` is clean;
- `pnpm licenses list --prod --json` and every direct dependency report contain only
  allowlisted licences;
- every publishable package has `publishConfig.provenance: true`;
- npm provenance metadata is recorded for production direct dependencies where available, and
  missing attestations are named;
- every direct dependency has a rationale in [`dependencies.md`](dependencies.md);
- `reports/dependency-health.json` and `reports/sbom.cyclonedx.json` are current.

Update the committed reports with:

```bash
pnpm supply-chain:report
```

## Provenance

Every publishable `@lorepack/*` package sets:

```json
{
  "publishConfig": {
    "access": "public",
    "provenance": true
  }
}
```

The release workflow grants `id-token: write`, uses `actions/setup-node` with the npm registry,
and publishes through `pnpm changeset publish`. npm provenance is therefore emitted by npm for
every package publish that supports it.

For dependencies, the health report reads npm registry `dist.attestations.provenance` metadata
for exact production direct dependencies. Missing attestations are reported by package name, not
silently ignored.

## Versioning Policy

Changesets owns package version changes and package changelog entries. All publishable
`@lorepack/*` packages move together for v0.1 through the fixed Changesets group in
[`.changeset/config.json`](../../.changeset/config.json). Keeping the package versions aligned
keeps the compatibility story simple while the public surface is still settling.

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
generation, example package creation and npm tarball packing, then uploads the artifacts without
committing, tagging, creating a GitHub release or publishing to npm.

A real release then commits the version changes, tags `vX.Y.Z`, creates the GitHub release, and
publishes packages with npm provenance through `pnpm changeset publish --tag <channel>`.

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
5. Use `lore activate` or `lore rollback` for affected local projects and Cloudflare target
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
