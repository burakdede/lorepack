#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseStructureProblems, topLevelPermissionProblems } from './release-structure.mjs';

const ROOT = process.env.LOREPACK_ROOT ?? join(import.meta.dirname, '..');
const RELEASE = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const PUBLIC_SMOKE = readFileSync(
  join(ROOT, '.github', 'workflows', 'public-registry-smoke.yml'),
  'utf8',
);
const WORKFLOWS_WITH_READ_DEFAULT = ['ci.yml', 'commit-hygiene.yml'];
const CHANGESETS = readFileSync(join(ROOT, '.changeset', 'config.json'), 'utf8');
const SUPPLY_CHAIN = readFileSync(
  join(ROOT, 'docs', 'architecture', 'release-supply-chain.md'),
  'utf8',
);
const CHECKLIST = readFileSync(join(ROOT, 'docs', 'release-checklist.md'), 'utf8');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const GETTING_STARTED = readFileSync(join(ROOT, 'docs', 'getting-started.md'), 'utf8');
const UPGRADE_NOTES = join(ROOT, 'docs', 'compatibility', 'v0.1-upgrade.md');

const REQUIRED = [
  'verify (ubuntu-latest)',
  'verify (windows-latest)',
  'verify (macos-latest)',
  'acceptance (ubuntu-latest)',
  'acceptance (windows-latest)',
  'acceptance (macos-latest)',
  'clean install (ubuntu-latest)',
  'clean install (windows-latest)',
  'clean install (macos-latest)',
  'cloudflare acceptance (ubuntu-latest)',
  'studio e2e (ubuntu-latest)',
  'benchmarks (reported)',
];

const problems = [];

// Which job holds which capability, from the parsed workflow rather than from substrings (#604).
problems.push(...releaseStructureProblems(RELEASE));
for (const name of WORKFLOWS_WITH_READ_DEFAULT) {
  const path = join(ROOT, '.github', 'workflows', name);
  if (existsSync(path)) {
    problems.push(...topLevelPermissionProblems(name, readFileSync(path, 'utf8')));
  } else {
    problems.push(`${name} is missing`);
  }
}

const changesetConfig = JSON.parse(CHANGESETS);

if (changesetConfig.fixed?.length !== 0) {
  problems.push(
    '.changeset/config.json must not force private implementation packages into releases',
  );
}

if (!RELEASE.includes('workflow_dispatch:')) {
  problems.push('release.yml must be a manually dispatched workflow');
}
if (!RELEASE.includes('dry_run:')) problems.push('release.yml must expose dry_run');
if (!RELEASE.includes('channel:')) problems.push('release.yml must expose channel');
if (!RELEASE.includes('performance_report_url:')) {
  problems.push('release.yml must require performance report evidence before stable publish');
}
if (!RELEASE.includes('pnpm changeset version')) {
  problems.push('release.yml must run pnpm changeset version');
}
if (!RELEASE.includes('docs/compatibility/v0.1-upgrade.md') && !process.env.LOREPACK_ROOT) {
  problems.push('release.yml must include the versioned upgrade notes in release notes');
}
if (existsSync(UPGRADE_NOTES)) {
  if (!readFileSync(UPGRADE_NOTES, 'utf8').includes('schemaVersion')) {
    problems.push('v0.1 upgrade notes must document schemaVersion compatibility');
  }
} else if (!process.env.LOREPACK_ROOT) {
  problems.push('v0.1 upgrade notes must document schemaVersion compatibility');
}
if (!RELEASE.includes('scripts/publish-packages.mjs --tag "$RELEASE_CHANNEL" --tarballs')) {
  problems.push('release.yml must publish packages with an explicit npm dist tag');
}
if (!RELEASE.includes('scripts/preflight-npm-packages.mjs')) {
  problems.push('release.yml must preflight npm package bootstrap');
}
if (!RELEASE.includes('scripts/publish-packages.mjs')) {
  problems.push('release.yml must use the tested npm publisher');
}
if (!RELEASE.includes('Trusted Publishing')) {
  problems.push('release.yml must use npm Trusted Publishing for real releases');
}
if (RELEASE.includes('NPM_TOKEN') || RELEASE.includes('NODE_AUTH_TOKEN')) {
  problems.push('release.yml must not use a long-lived npm publish token');
}
if (!RELEASE.includes('id-token: write')) {
  problems.push('release.yml must grant id-token: write for npm provenance');
}
if (!RELEASE.includes('check-runs') || !RELEASE.includes('$conclusion" != "success"')) {
  problems.push('release.yml must verify successful required check runs before publish');
}
if (!RELEASE.includes('gh release create')) {
  problems.push('release.yml must create the GitHub release');
}
if (!RELEASE.includes('--prerelease')) {
  problems.push('release.yml must mark prerelease versions as GitHub prereleases');
}
if (!RELEASE.includes('examples/product-research/product-research.lorepack')) {
  problems.push('release.yml must attach a .lorepack example artifact');
}
if (!RELEASE.includes('reports/sbom.cyclonedx.json')) {
  problems.push('release.yml must attach the CycloneDX SBOM');
}
if (!RELEASE.includes('stable publish requires the green issue #101 performance report URL')) {
  problems.push('release.yml must block stable publish without a green performance report');
}
if (!RELEASE.includes('scripts/pack-cli.mjs --out')) {
  problems.push('release.yml must pack the CLI with its tested dependency tree bundled');
}
if (!RELEASE.includes('scripts/check-packed-cli.mjs --tarball')) {
  problems.push('release.yml must check the packed CLI with an npm install before publishing');
}
if (!RELEASE.includes('LOREPACK_VERSION')) {
  problems.push('release.yml must stamp the requested version into release evidence');
}
if (!RELEASE.includes('CHANGELOG.md')) {
  problems.push('release.yml must stamp the requested version into package changelogs');
}
if (!RELEASE.includes('scripts/stamp-release-version.mjs')) {
  problems.push('release.yml must use the tested release version stamping script');
}

for (const phrase of [
  'Alpha status',
  'Cloudflare deploy is experimental',
  '1 GiB scale envelope is untested',
  'Approvals, evidence capture and semantic search are not in v0.1',
  'docs/limitations.md',
  'GHSA-c53f-24h5-74qj',
]) {
  if (!RELEASE.includes(phrase)) problems.push(`release.yml alpha notes lack ${phrase}`);
}

for (const [name, contents] of [
  ['README.md', README],
  ['docs/getting-started.md', GETTING_STARTED],
]) {
  if (!contents.includes('npm install -g @lorepack/cli@next')) {
    problems.push(`${name} must document the alpha npm install command`);
  }
}

for (const phrase of [
  'release:',
  'types: [published]',
  'npm audit signatures',
  'scripts/check-registry-provenance.mjs',
  'workflow_dispatch:',
  'ubuntu-latest',
  'windows-latest',
  'macos-latest',
  'npm view',
  'seq 1 30',
  'sleep 10',
  'npm install --global --ignore-scripts',
  'scripts/public-registry-smoke.mjs',
  'GITHUB_STEP_SUMMARY',
]) {
  if (!PUBLIC_SMOKE.includes(phrase)) {
    problems.push(`public-registry-smoke.yml lacks ${phrase}`);
  }
}

const trustedPublishingPreflight = RELEASE.indexOf(
  'Require npm Trusted Publishing for real release',
);
for (const sideEffect of [
  'Commit version and generated release artifacts',
  'Create GitHub release with SBOM and example artifact',
  'Publish npm packages with Trusted Publishing',
]) {
  const sideEffectIndex = RELEASE.indexOf(sideEffect);
  if (
    trustedPublishingPreflight === -1 ||
    sideEffectIndex === -1 ||
    trustedPublishingPreflight > sideEffectIndex
  ) {
    problems.push(`release.yml must check npm Trusted Publishing before ${sideEffect}`);
  }
}

for (const check of REQUIRED) {
  if (!RELEASE.includes(check)) problems.push(`release.yml does not require ${check}`);
}

for (const phrase of [
  'Versioning Policy',
  'Release Checklist',
  'Rollback and Deprecation',
  '`next`',
  '`formatVersion`',
  '`schemaVersion`',
]) {
  if (!SUPPLY_CHAIN.includes(phrase) && !CHECKLIST.includes(phrase)) {
    problems.push(`release documentation does not cover ${phrase}`);
  }
}

for (const phrase of [
  'client trust prompts',
  'Cloudflare acceptance',
  'demo script',
  'dry-run',
  'performance report',
  'deprecate',
]) {
  if (!CHECKLIST.includes(phrase)) problems.push(`docs/release-checklist.md lacks ${phrase}`);
}

if (problems.length > 0) {
  console.error('check:release-policy failed.\n');
  for (const problem of problems.sort((a, b) => a.localeCompare(b))) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

console.log(`check:release-policy: ${REQUIRED.length} required release checks enforced`);
