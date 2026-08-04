#!/usr/bin/env node
// Every source file must be tracked by git. An untracked file passes locally and fails in
// CI, and the cause is easy to miss: a personal global gitignore can exclude a directory
// the repository needs. See docs/architecture/cli.md.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOTS = ['packages', 'tools', 'scripts'];
// `.sql` is here for a reason: migrations live under a directory named `build`, and a
// too-broad ignore rule kept a new one out of a commit while every local test passed.
// Anything the product loads at runtime belongs in this pattern, not just code.
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|sql)$/;
// `studio-dist` is Vite's output inside the CLI package, which is published but never
// committed, exactly like `dist`. Without it this check reports the bundle it just built.
const SKIP = new Set(['node_modules', 'dist', 'studio-dist', 'coverage']);

const tracked = new Set(
  execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean),
);

const untracked = [];
function walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry) || entry.startsWith('.')) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!SOURCE.test(entry)) continue;
    const relativePath = relative(process.cwd(), full).split(sep).join('/');
    if (!tracked.has(relativePath)) untracked.push(relativePath);
  }
}
for (const root of ROOTS) walk(root);

if (untracked.length > 0) {
  console.error('These source files exist but are not tracked by git:\n');
  for (const file of untracked) console.error(`  ${file}`);
  console.error('\nThey would pass locally and fail in CI. Check `git check-ignore -v <file>`:');
  console.error('a personal global gitignore may be excluding a directory this repo needs.');
  process.exit(1);
}
console.log(`check:sources-tracked: clean (${tracked.size} tracked files)`);
