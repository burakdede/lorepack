---
'@lorepack/cli': patch
---

Add the v0.1 release automation gate: pull requests now require a Changesets entry or an
explicit no-release marker, and the manual release workflow dry-runs versioning, SBOM
generation, package tarball creation and example archive creation before any publish-side
effect.
