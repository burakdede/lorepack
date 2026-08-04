#!/usr/bin/env node
// Every picture is referenced, every reference resolves, and every file is **tracked by git**.
//
// Three failures this prevents, all of which are only embarrassing in a README. A broken image
// link renders as an alt-text box in the one document people read first. An orphaned file
// stays in the repository forever, because nobody deletes an image in case something uses it.
// And an image that exists locally but is ignored renders for its author and for nobody else.
//
// The third is not hypothetical and is why this file was rewritten. The first version asked the
// filesystem whether an image existed. It did, locally, having just been generated, so the
// check passed on six PNGs that a blanket `*.png` in `.gitignore` meant could never be
// committed. `main` went red and the README showed six broken icons (#214). This is exactly
// the class `check-sources-tracked` was written for, one file over: "they would pass locally
// and fail in CI."
//
// So the question asked here is git's, not the filesystem's. `git ls-files` reports what a
// clone would actually contain, which is the only thing GitHub can render.
//
// It does not check that a picture is *current*: nothing can, short of comparing pixels. What
// keeps them current is that `pnpm docs:capture` regenerates all of them from a real build, so
// retaking is cheaper than arguing about whether a screenshot has drifted.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

/**
 * What a clone would contain.
 *
 * Staged counts: a file added but not yet committed is on its way into the repository, and
 * failing the check a contributor runs between `git add` and `git commit` would be noise.
 * A file that is merely present on disk does not count, which is the whole point.
 */
function trackedImages() {
  const listed = execFileSync('git', ['ls-files', '--cached', '--', 'docs/images'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return new Set(
    listed
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split('/').at(-1) ?? ''),
  );
}

const tracked = trackedImages();
const onDisk = new Set(existsSync(IMAGES) ? readdirSync(IMAGES) : []);
const referenced = new Set();
const problems = [];

for (const file of [join(ROOT, 'README.md'), ...markdownFiles(join(ROOT, 'docs'))]) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (!target.includes('images/')) continue;
    const name = target.split('/').at(-1) ?? '';
    referenced.add(name);
    if (tracked.has(name)) continue;

    // The two cases read differently to whoever has to fix them, so they say different things.
    // "Missing" sends you to `docs:capture`; "ignored" sends you to `.gitignore`, and nothing
    // about the repository state tells you which without being told.
    problems.push(
      onDisk.has(name)
        ? `${relative(ROOT, file)} references ${name}, which exists locally but is not tracked by git`
        : `${relative(ROOT, file)} references missing ${name}`,
    );
  }
}

for (const name of [...tracked].sort()) {
  if (!referenced.has(name)) problems.push(`docs/images/${name} is referenced by nothing`);
}

if (problems.length > 0) {
  console.error('check:docs-images: problems found');
  for (const problem of problems) console.error(`  ${problem}`);
  const ignored = [...onDisk].some((name) => !tracked.has(name) && referenced.has(name));
  console.error(
    ignored
      ? '\nThose files exist here and would not exist in a clone. Check `git check-ignore -v docs/images/<file>`.'
      : '\nRun `pnpm docs:capture` to regenerate, or remove what is no longer used.',
  );
  process.exit(1);
}

console.log(`check:docs-images: ${tracked.size} images, all referenced and all tracked by git`);
