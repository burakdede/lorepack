#!/usr/bin/env node
// Apache-2.0 is a repository-level policy. The root LICENSE is the canonical notice for
// source files, and every package manifest must agree with it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const WORKSPACE_DIRS = ['packages', 'apps', 'tools'];
const problems = [];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function packageManifests() {
  const manifests = [join(ROOT, 'package.json')];
  for (const workspaceDir of WORKSPACE_DIRS) {
    const parent = join(ROOT, workspaceDir);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent)) {
      const manifest = join(parent, entry, 'package.json');
      if (existsSync(manifest)) manifests.push(manifest);
    }
  }
  return manifests;
}

const licensePath = join(ROOT, 'LICENSE');
if (!existsSync(licensePath)) {
  problems.push('LICENSE is missing');
} else {
  const license = readFileSync(licensePath, 'utf8');
  if (!license.includes('Apache License') || !license.includes('Version 2.0')) {
    problems.push('LICENSE is not the Apache License 2.0 text');
  }
}

for (const manifestPath of packageManifests()) {
  const manifest = readJson(manifestPath);
  if (manifest.license !== 'Apache-2.0') {
    problems.push(`${manifestPath.replace(`${ROOT}/`, '')}: license must be Apache-2.0`);
  }
}

if (existsSync(join(ROOT, 'NOTICE'))) {
  const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8').trim();
  if (notice.length === 0) problems.push('NOTICE exists but is empty');
}

if (problems.length > 0) {
  console.error('check:license-policy failed.\n');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`check:license-policy: ${packageManifests().length} package manifests use Apache-2.0`);
