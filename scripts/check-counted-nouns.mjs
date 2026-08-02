#!/usr/bin/env node
// Rejects a hardcoded plural in user-facing output. See #150 and #167.
//
// `count()` and `noun()` in @lorepack/core exist because every renderer had been writing
// `${n} artifacts`, so the CLI said "1 artifacts", "1 chunks" and "Removing 1 builds".
// #150 built the helper and converted four commands; `inspect` and `diff` kept their own
// copies and kept saying "1 chunks" for another two months. A rule catches the next one.
//
// The check is deliberately narrow: an interpolation immediately followed by a plural noun
// this project counts. It looks for the shape of the defect, not for English in general.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const NOUNS = [
  'artifacts',
  'builds',
  'chunks',
  'files',
  'members',
  'nodes',
  'objects',
  'rows',
  'tables',
  'tokens',
  'warnings',
];

// `${expression} noun`, which is the construction that cannot agree with its number.
const OFFENDING = new RegExp(`\\$\\{[^}]+\\}\\s+(${NOUNS.join('|')})\\b`);

// Only where output is produced. Tests assert on rendered text and must be able to write
// the plural form literally; fixtures and documentation are prose.
const SEARCHED = /^(packages|tools)\/[^/]+\/src\/.*\.ts$/;

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => SEARCHED.test(file));

const offenders = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, index) => {
    // A comment may quote the defect it explains, as the helper's own docblock does.
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
    if (OFFENDING.test(line)) offenders.push(`${file}:${index + 1}: ${trimmed.slice(0, 90)}`);
  });
}

if (offenders.length > 0) {
  console.error(`Found ${offenders.length} hardcoded plural(s) in user-facing output.`);
  console.error('Use `count(n, "noun")` from @lorepack/core, which agrees with its number.\n');
  for (const offender of offenders) console.error(`  ${offender}`);
  process.exit(1);
}
console.log(`check:counted-nouns: clean (${files.length} files)`);
