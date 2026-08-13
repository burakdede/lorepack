#!/usr/bin/env node
// The public templates are triage tools, not decoration. Keep the fields reviewers need
// present, or reports arrive without the facts needed to reproduce them.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const REQUIRED = new Map([
  [
    '.github/ISSUE_TEMPLATE/bug.yml',
    ['id: platform', 'id: node', 'id: doctor', 'lore doctor --json', 'Output of `node --version`'],
  ],
  [
    '.github/ISSUE_TEMPLATE/parser-support.yml',
    ['id: format', 'id: expected', 'id: actual', 'id: fixture'],
  ],
  [
    '.github/ISSUE_TEMPLATE/client-support.yml',
    ['id: client', 'id: transport', 'lore connect <client> --dry-run', 'Platform and Node version'],
  ],
  [
    '.github/ISSUE_TEMPLATE/feature.yml',
    [
      'id: problem',
      'id: proposal',
      'Which promise does this strengthen?',
      'Build, Inspect, Connect, Deploy',
    ],
  ],
  [
    '.github/PULL_REQUEST_TEMPLATE.md',
    [
      'Closes #',
      '## What was verified',
      'unit / integration / e2e / contract / determinism / cross-platform / security / manual',
      'Handoff comment posted',
    ],
  ],
]);

const problems = [];

for (const [relativePath, needles] of REQUIRED) {
  const fullPath = join(ROOT, relativePath);
  if (!existsSync(fullPath)) {
    problems.push(`${relativePath} is missing`);
    continue;
  }
  const text = readFileSync(fullPath, 'utf8');
  for (const needle of needles) {
    if (!text.includes(needle)) problems.push(`${relativePath} does not contain ${needle}`);
  }
}

if (problems.length > 0) {
  console.error('check:templates failed. Public issue and PR templates drifted.\n');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`check:templates: ${REQUIRED.size} templates contain required contributor prompts`);
