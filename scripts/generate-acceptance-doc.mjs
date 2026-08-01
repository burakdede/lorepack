#!/usr/bin/env node
// Regenerates docs/testing/acceptance.md from the scenario catalogue.
// Run with --check in CI: it fails when a scenario changed without regenerating the doc.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCatalogue, SCENARIOS } from '../tools/acceptance/dist/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repoRoot, 'docs', 'testing', 'acceptance.md');
const check = process.argv.includes('--check');

const expected = renderCatalogue();
const current = existsSync(target) ? readFileSync(target, 'utf8') : null;

if (current === expected) {
  console.log(`acceptance:docs: ${SCENARIOS.length} scenarios, ${target} is current`);
  process.exit(0);
}

if (check) {
  console.error('docs/testing/acceptance.md does not match the scenario catalogue.\n');
  console.error(current === null ? '  the file is missing' : '  the file is out of date');
  console.error('\nRun `pnpm acceptance:docs` and commit the result.');
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, expected, 'utf8');
console.log(`acceptance:docs: wrote ${SCENARIOS.length} scenarios to ${target}`);
