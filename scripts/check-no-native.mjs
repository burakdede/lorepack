#!/usr/bin/env node
// Guards the zero-surprise install promise: no native add-ons, no install scripts.
// See AGENTS.md section 9 and architecture section 6.1.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

/**
 * 2. No banned native package in what a **user** installs.
 *
 * Scoped to the production dependency closure of the published packages, not to the whole
 * `node_modules` tree, and that is a deliberate narrowing rather than a relaxation (#256).
 *
 * The promise is invariant 7: *no Python, Docker, compiler toolchain, native add-on, model
 * download, API key or account. Ever.* It is a promise about **someone installing Lorepack**.
 * A build tool in a contributor's tree breaks none of it, and the whole-tree version of this
 * check could not tell the two apart: it refused Miniflare, which is a dev-only Cloudflare
 * emulator that never reaches a published package, on the strength of a transitive `sharp`.
 *
 * Narrowing makes the guard say something true and checkable instead of something broader and
 * wrong. What it must never lose is the part that matters, so the mutation to run against any
 * future edit here is: **add a native dependency to a published package and watch this fail.**
 * `test/no-native.test.ts` does exactly that.
 */
function publishedClosure() {
  const listed = JSON.parse(
    execFileSync(
      'pnpm',
      ['list', '--prod', '--depth', 'Infinity', '--json', '-r', '--filter', './packages/*'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
  );

  /** name -> resolved path, for every production dependency reachable from a published package. */
  const reached = new Map();
  const walk = (dependencies) => {
    for (const [name, node] of Object.entries(dependencies ?? {})) {
      // A workspace link is one of ours; its own dependencies are walked, not the link.
      if (typeof node?.version === 'string' && node.version.startsWith('link:')) {
        walk(node.dependencies);
        continue;
      }
      if (reached.has(name)) continue;
      reached.set(name, node?.path ?? null);
      walk(node?.dependencies);
    }
  };
  for (const workspace of listed) {
    if (workspace.private === true) continue;
    walk(workspace.dependencies);
  }
  return reached;
}

/**
 * Direct production dependencies, read from the manifests rather than from the installed tree.
 *
 * Both halves are needed and they catch different things. A manifest read catches a native
 * dependency the moment it is **declared**, before anyone installs, which is when a reviewer is
 * looking at the diff. The installed closure below catches one that arrives **transitively**,
 * which no manifest mentions.
 */
for (const file of ours) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  if (pkg.private === true || !file.startsWith('packages/')) continue;
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (BANNED_PACKAGES.includes(name)) {
      problems.push(`${file} declares ${name}, which ships native code`);
    }
  }
}

for (const [name, path] of publishedClosure()) {
  if (BANNED_PACKAGES.includes(name)) {
    problems.push(`a published package depends on ${name}, which ships native code`);
  }
  if (path !== null && existsSync(join(path, 'binding.gyp'))) {
    problems.push(`native add-on (binding.gyp) in ${name}, reachable from a published package`);
  }
}

if (problems.length > 0) {
  console.error(
    'check:no-native failed. The core install must never compile or download binaries.\n',
  );
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('check:no-native: clean');
