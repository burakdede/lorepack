#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const files = execFileSync('git', ['ls-files', '*.md'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);

const markdownFiles = new Set(files.map((file) => normalize(join(ROOT, file))));
const anchorCache = new Map();
const failures = [];

for (const file of files) {
  const absolute = join(ROOT, file);
  const text = readFileSync(absolute, 'utf8');
  for (const link of linksIn(text)) {
    checkLink(absolute, file, link);
  }
}

if (failures.length > 0) {
  console.error('check:docs-links: broken local documentation links');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`check:docs-links: checked ${files.length} markdown files`);

function linksIn(text) {
  const links = [];
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    links.push(match[1].trim());
  }
  for (const match of text.matchAll(/<((?:\.{1,2}|\/)[^>\n]+)>/g)) {
    const value = match[1].trim();
    if (/^\/[A-Za-z][\w:-]*$/.test(value)) continue;
    links.push(value);
  }
  return links;
}

function checkLink(fromAbsolute, fromRelative, rawLink) {
  if (rawLink === '' || rawLink.startsWith('#')) {
    checkAnchor(fromAbsolute, fromRelative, rawLink.slice(1));
    return;
  }
  if (isExternal(rawLink) || rawLink.startsWith('mailto:')) return;

  const [targetPart, anchor = ''] = rawLink.split('#');
  const decodedTarget = decodeURIComponent(targetPart);
  const targetAbsolute = normalize(resolve(dirname(fromAbsolute), decodedTarget));
  if (!insideRoot(targetAbsolute)) {
    failures.push(`${fromRelative}: ${rawLink} escapes the repository root`);
    return;
  }
  if (!existsSync(targetAbsolute)) {
    failures.push(`${fromRelative}: ${rawLink} points at a missing file`);
    return;
  }
  if (anchor !== '') checkAnchor(targetAbsolute, fromRelative, anchor, rawLink);
}

function insideRoot(path) {
  const rel = relative(ROOT, path);
  return rel === '' || (!rel.startsWith('..') && !rel.split(sep).includes('..'));
}

function isExternal(link) {
  return /^[a-z][a-z0-9+.-]*:/i.test(link);
}

function checkAnchor(fileAbsolute, fromRelative, anchor, rawLink = `#${anchor}`) {
  const target = statSync(fileAbsolute).isDirectory()
    ? join(fileAbsolute, 'README.md')
    : fileAbsolute;
  if (extname(target) !== '.md') return;
  if (!markdownFiles.has(normalize(target))) {
    failures.push(`${fromRelative}: ${rawLink} points at an untracked markdown file`);
    return;
  }
  const anchors = anchorsFor(target);
  if (!anchors.has(decodeURIComponent(anchor).toLowerCase())) {
    failures.push(`${fromRelative}: ${rawLink} points at a missing heading`);
  }
}

function anchorsFor(fileAbsolute) {
  const key = normalize(fileAbsolute);
  const cached = anchorCache.get(key);
  if (cached) return cached;
  const text = readFileSync(fileAbsolute, 'utf8');
  const anchors = new Set();
  for (const match of text.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
    anchors.add(slug(match[2]));
  }
  anchorCache.set(key, anchors);
  return anchors;
}

function slug(heading) {
  return heading
    .replaceAll(/<[^>]+>/g, '')
    .replaceAll(/`([^`]+)`/g, '$1')
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replaceAll(/\s+/g, '-');
}
