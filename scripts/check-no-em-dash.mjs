#!/usr/bin/env node
// Rejects U+2014 (em dash) anywhere in tracked text files. See AGENTS.md section 8.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EM_DASH = '—';
const BINARY = /\.(docx|png|jpg|jpeg|gif|webp|ico|pdf|xlsx|zip|lorepack|woff2?)$/i;

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !BINARY.test(f));

const offenders = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (line.includes(EM_DASH)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 80)}`);
  });
}

if (offenders.length > 0) {
  console.error(`Found ${offenders.length} em dash (U+2014) occurrence(s). Use a colon, comma,`);
  console.error('parentheses, or two sentences instead. See AGENTS.md section 8.\n');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(`check:no-em-dash: clean (${files.length} files)`);
