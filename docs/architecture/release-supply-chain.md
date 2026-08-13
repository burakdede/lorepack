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

## Release artifacts

The release workflow is manual because the v0.1 release process still cuts GitHub releases
explicitly. It requires the existing release tag as input, regenerates the reports, uploads
them as a workflow artifact, then attaches both files to that GitHub release with `gh release
upload --clobber`.

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
