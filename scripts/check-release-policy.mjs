#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.LOREPACK_ROOT ?? join(import.meta.dirname, '..');
const RELEASE = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const CHANGESETS = readFileSync(join(ROOT, '.changeset', 'config.json'), 'utf8');
const SUPPLY_CHAIN = readFileSync(
  join(ROOT, 'docs', 'architecture', 'release-supply-chain.md'),
  'utf8',
);
const CHECKLIST = readFileSync(join(ROOT, 'docs', 'release-checklist.md'), 'utf8');

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
  'benchmarks (reported, not enforced)',
];

const problems = [];
const changesetConfig = JSON.parse(CHANGESETS);

if (changesetConfig.fixed?.some((group) => group.includes('@lorepack/*')) !== true) {
  problems.push('.changeset/config.json must keep @lorepack/* packages versioned together');
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
if (!RELEASE.includes('pnpm changeset publish --tag')) {
  problems.push('release.yml must publish with an explicit npm dist tag');
}
if (!RELEASE.includes('NPM_TOKEN')) problems.push('release.yml must use NPM_TOKEN for publish');
if (!RELEASE.includes('Require npm publish token for real release')) {
  problems.push('release.yml must check NPM_TOKEN before real release side effects');
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
if (!RELEASE.includes('examples/product-research/product-research.lorepack')) {
  problems.push('release.yml must attach a .lorepack example artifact');
}
if (!RELEASE.includes('reports/sbom.cyclonedx.json')) {
  problems.push('release.yml must attach the CycloneDX SBOM');
}
if (!RELEASE.includes('stable publish requires the green issue #101 performance report URL')) {
  problems.push('release.yml must block stable publish without a green performance report');
}
if (!RELEASE.includes('pack --pack-destination')) {
  problems.push('release.yml dry runs must create package tarballs without publishing');
}

const tokenPreflight = RELEASE.indexOf('Require npm publish token for real release');
for (const sideEffect of [
  'Commit version and generated release artifacts',
  'Create GitHub release with SBOM and example artifact',
  'Publish npm packages with provenance',
]) {
  const sideEffectIndex = RELEASE.indexOf(sideEffect);
  if (tokenPreflight === -1 || sideEffectIndex === -1 || tokenPreflight > sideEffectIndex) {
    problems.push(`release.yml must check NPM_TOKEN before ${sideEffect}`);
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
