#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const ROOT = process.env.LOREPACK_ROOT ?? join(import.meta.dirname, '..');
const NO_RELEASE_MARKER = '[no release]';
const VERSION_CHANGE = /^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n\S/;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function changedFiles() {
  const base = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : (process.env.CHANGESET_BASE_REF ?? 'origin/main');
  const head = process.env.CHANGESET_HEAD_REF ?? 'HEAD';
  try {
    const mergeBase = git(['merge-base', base, head]);
    const comparisonHeads = head === 'HEAD' ? mergeParentHeads() : [];
    return unique([
      ...lines(git(['diff', '--name-only', `${mergeBase}...${head}`])),
      ...comparisonHeads.flatMap((head) =>
        lines(git(['diff', '--name-only', `${mergeBase}...${head}`])),
      ),
      ...lines(git(['diff', '--name-only'])),
      ...lines(git(['diff', '--name-only', '--cached'])),
      ...lines(git(['ls-files', '--others', '--exclude-standard'])),
    ]);
  } catch {
    return unique([
      ...lines(git(['diff', '--name-only'])),
      ...lines(git(['diff', '--name-only', '--cached'])),
      ...lines(git(['ls-files', '--others', '--exclude-standard'])),
    ]);
  }
}

function commitMessages() {
  try {
    const base = process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : (process.env.CHANGESET_BASE_REF ?? 'origin/main');
    const head = process.env.CHANGESET_HEAD_REF ?? 'HEAD';
    const mergeBase = git(['merge-base', base, head]);
    const comparisonHeads = head === 'HEAD' ? mergeParentHeads() : [];
    return [
      git(['log', '--no-merges', '--format=%s%x1f', `${mergeBase}..${head}`]),
      ...comparisonHeads.map((head) =>
        git(['log', '--no-merges', '--format=%s%x1f', `${mergeBase}..${head}`]),
      ),
    ].join('\x1f');
  } catch {
    return git(['log', '--no-merges', '--format=%s%x1f', '-1']);
  }
}

function mergeParentHeads() {
  try {
    return lines(git(['rev-list', '--parents', '-n', '1', 'HEAD']))
      .slice(2)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function lines(text) {
  return text.split('\n').filter(Boolean);
}

function unique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

const files = changedFiles();
const changesets = files.filter(
  (file) =>
    file.startsWith('.changeset/') && file.endsWith('.md') && basename(file) !== 'README.md',
);
const hasChangeset = changesets.some((file) => VERSION_CHANGE.test(fileAtComparisonHead(file)));
const hasNoReleaseMarker = commitMessages().includes(NO_RELEASE_MARKER);

if (!existsSync(join(ROOT, '.changeset', 'config.json'))) {
  console.error('check:changeset-policy: .changeset/config.json is missing');
  process.exit(1);
}

if (!hasChangeset && !hasNoReleaseMarker) {
  console.error('check:changeset-policy: pull requests need a changeset or [no release]');
  console.error('Add `pnpm changeset`, or include [no release] in one commit message.');
  process.exit(1);
}

if (hasChangeset && hasNoReleaseMarker) {
  console.error('check:changeset-policy: use either a changeset or [no release], not both');
  process.exit(1);
}

console.log(
  hasChangeset
    ? `check:changeset-policy: ${changesets.length} changeset file(s) found`
    : 'check:changeset-policy: [no release] marker found',
);

function fileAtComparisonHead(file) {
  if (existsSync(join(ROOT, file))) {
    return readFileSync(join(ROOT, file), 'utf8');
  }
  if (process.env.CHANGESET_HEAD_REF) {
    return git(['show', `${process.env.CHANGESET_HEAD_REF}:${file}`]);
  }
  return '';
}
