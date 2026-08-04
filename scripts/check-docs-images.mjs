#!/usr/bin/env node
// Every picture is referenced, and every reference resolves.
//
// Two failures this prevents, both of which are only embarrassing in a README. A broken image
// link renders as an alt-text box in the one document people read first. An orphaned file
// stays in the repository forever, because nobody deletes an image in case something uses it.
//
// It does not check that a picture is *current*: nothing can, short of comparing pixels. What
// keeps them current is that `pnpm docs:capture` regenerates all of them from a real build, so
// retaking is cheaper than arguing about whether a screenshot has drifted.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const IMAGES = join(ROOT, 'docs', 'images');

function markdownFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') return [];
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return markdownFiles(full);
    return entry.endsWith('.md') ? [full] : [];
  });
}

const present = new Set(readdirSync(IMAGES));
const referenced = new Set();
const broken = [];

for (const file of [join(ROOT, 'README.md'), ...markdownFiles(join(ROOT, 'docs'))]) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (!target.includes('images/')) continue;
    const name = target.split('/').at(-1) ?? '';
    referenced.add(name);
    if (!present.has(name)) broken.push(`${relative(ROOT, file)} references missing ${name}`);
  }
}

const orphans = [...present].filter((name) => !referenced.has(name)).sort();
const problems = [
  ...broken,
  ...orphans.map((name) => `docs/images/${name} is referenced by nothing`),
];

if (problems.length > 0) {
  console.error('check:docs-images: problems found');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nRun `pnpm docs:capture` to regenerate, or remove what is no longer used.');
  process.exit(1);
}

console.log(`check:docs-images: ${present.size} images, all referenced and all present`);
