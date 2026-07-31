#!/usr/bin/env node
// Guards the zero-surprise install promise: no native add-ons, no install scripts.
// See AGENTS.md section 9 and architecture section 6.1.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BANNED_PACKAGES = [
  '@napi-rs/canvas',
  'canvas',
  'better-sqlite3',
  'node-gyp',
  'prebuild-install',
  'node-pre-gyp',
  '@mapbox/node-pre-gyp',
  'onnxruntime-node',
  'sharp',
];
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];
const problems = [];

// 1. No install hooks in our own packages.
const ours = execFileSync('git', ['ls-files', '*package.json'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
for (const file of ours) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  for (const hook of INSTALL_HOOKS) {
    if (pkg.scripts?.[hook]) problems.push(`${file}: declares a "${hook}" script`);
  }
}

// 2. No banned native package anywhere in the installed tree.
function scan(dir, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules') {
      scan(full, depth + 1);
      continue;
    }
    if (entry.startsWith('@')) {
      scan(full, depth + 1);
      continue;
    }
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const name = dir.includes('node_modules/@')
      ? `${dir.slice(dir.lastIndexOf('@'))}/${entry}`
      : entry;
    if (BANNED_PACKAGES.includes(name)) problems.push(`installed tree contains ${name} (${full})`);
    if (existsSync(join(full, 'binding.gyp')))
      problems.push(`native add-on (binding.gyp) at ${full}`);
    scan(join(full, 'node_modules'), depth + 1);
  }
}
scan('node_modules');

if (problems.length > 0) {
  console.error(
    'check:no-native failed. The core install must never compile or download binaries.\n',
  );
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('check:no-native: clean');
