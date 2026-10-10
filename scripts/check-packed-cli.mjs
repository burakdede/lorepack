#!/usr/bin/env node
// Installs the CLI the way a user does, with npm into an empty directory, and checks what
// arrived: no native add-on, the production tree CI tested, a PDF build that loads nothing
// native, and a clean `npm audit --omit=dev`.
//
// The workspace checks (`check:no-native`, the clean-install job) inspect the pnpm install,
// which applies workspace overrides that never reach a published manifest. Only an npm install
// of the packed tarball shows what a user gets (#603).
//
// Usage:
//   node scripts/check-packed-cli.mjs                    pack this checkout, then check it
//   node scripts/check-packed-cli.mjs --tarball <tgz>    check a tarball already packed
//   node scripts/check-packed-cli.mjs --spec <spec>      check a published version, such as
//                                                        @lorepack/cli@0.1.0 (no lockfile
//                                                        comparison: the checkout may differ)
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BANNED_PACKAGES } from './check-no-native.mjs';
import { packCli, runTool } from './pack-cli.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PDF_FIXTURE = join(ROOT, 'benchmarks', 'corpus', 'generated', 'release-notes.pdf');

/**
 * Every installed package under `nodeModules`, as `name@version`, plus anything native.
 *
 * Walks the directories rather than asking npm, because the question is what is on disk:
 * an optional native package npm decided to fetch is exactly the thing to find.
 */
export function inspectInstalledTree(nodeModules) {
  const packages = new Set();
  const problems = [];

  function walk(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory() && entry.name.startsWith('@')) {
        walk(full);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const manifestPath = join(full, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
          packages.add(`${manifest.name}@${manifest.version}`);
          if (BANNED_PACKAGES.includes(manifest.name) || manifest.name.startsWith('@napi-rs/')) {
            problems.push(
              `native package ${manifest.name} installed at ${shown(nodeModules, full)}`,
            );
          }
        }
      }
      findNativeFiles(full, nodeModules, problems);
      walk(join(full, 'node_modules'));
    }
  }

  walk(nodeModules);
  return { packages, problems: problems.sort((a, b) => a.localeCompare(b)) };
}

function findNativeFiles(directory, base, problems) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Nested packages are visited by the tree walk itself.
      if (entry.name !== 'node_modules') findNativeFiles(full, base, problems);
    } else if (entry.name.endsWith('.node')) {
      problems.push(`native add-on ${shown(base, full)}`);
    }
  }
}

function shown(base, full) {
  return relative(base, full).replaceAll('\\', '/');
}

function packageName(entry) {
  return entry.slice(0, entry.lastIndexOf('@'));
}

/**
 * The packages one tree has that the other does not, as two sorted lists.
 *
 * An optional peer is excused from `missing`: the workspace resolves one whenever any
 * workspace package happens to provide it (`debug` picks up `supports-color` from dev
 * tooling), while a user's install correctly leaves it out.
 */
export function compareTrees(expected, installed, optionalPeers = new Set()) {
  return {
    missing: [...expected]
      .filter((entry) => !installed.has(entry) && !optionalPeers.has(packageName(entry)))
      .sort(),
    unexpected: [...installed].filter((entry) => !expected.has(entry)).sort(),
  };
}

/** Every package name the lockfile records as an optional peer of something. */
export function optionalPeerNames(root = ROOT) {
  const { parse } = createRequire(join(root, 'packages', 'cli', 'package.json'))('yaml');
  const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const names = new Set();
  for (const entry of Object.values(lock.packages ?? {})) {
    for (const [name, meta] of Object.entries(entry.peerDependenciesMeta ?? {})) {
      if (meta?.optional === true) names.add(name);
    }
  }
  return names;
}

/** The CLI's production closure from the frozen workspace lockfile, as `name@version`. */
export function lockedProductionTree(root = ROOT) {
  const result = runTool(
    'pnpm',
    ['--filter', '@lorepack/cli', 'list', '--prod', '--depth', 'Infinity', '--json'],
    root,
    { env: { CI: 'true' } },
  );
  const tree = new Set();
  const visit = (dependencies) => {
    for (const [name, node] of Object.entries(dependencies ?? {})) {
      if (typeof node.version === 'string' && !node.version.startsWith('link:')) {
        tree.add(`${name}@${node.version}`);
      }
      visit(node.dependencies);
    }
  };
  for (const project of JSON.parse(result.stdout)) visit(project.dependencies);
  return tree;
}

const DLOPEN_HOOK = `
const { appendFileSync } = require('node:fs');
const original = process.dlopen;
process.dlopen = function (module, filename, ...rest) {
  appendFileSync(process.env.LOREPACK_DLOPEN_LOG, filename + '\\n');
  return original.call(this, module, filename, ...rest);
};
`;

function runInstalledCli(installDir, projectDir, args, hookPath, logPath) {
  const entry = join(installDir, 'node_modules', '@lorepack', 'cli', 'dist', 'public-entry.js');
  const result = spawnSync(process.execPath, ['--require', hookPath, entry, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    env: { ...process.env, LOREPACK_DLOPEN_LOG: logPath, NO_COLOR: '1' },
  });
  if (result.status !== 0) {
    throw new Error(
      `lorepack ${args.join(' ')} exited ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function main() {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const spec = value('--spec');
  let tarball = value('--tarball');
  if ((spec !== undefined && tarball !== undefined) || args.length > 2) {
    console.error('usage: check-packed-cli.mjs [--tarball <tgz> | --spec <npm spec>]');
    process.exit(1);
  }

  const work = mkdtempSync(join(tmpdir(), 'lorepack-packed-'));
  const problems = [];
  try {
    if (spec === undefined && tarball === undefined) {
      tarball = packCli({ outDir: join(work, 'pack') });
      console.log(`packed ${tarball}`);
    }

    const installDir = join(work, 'install');
    mkdirSync(installDir);
    writeFileSync(
      join(installDir, 'package.json'),
      `${JSON.stringify({ name: 'lorepack-user', private: true })}\n`,
    );
    runTool(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', spec ?? resolve(tarball)],
      installDir,
    );

    const installed = inspectInstalledTree(join(installDir, 'node_modules'));
    problems.push(...installed.problems);
    console.log(`installed ${installed.packages.size} packages with npm`);

    if (spec === undefined) {
      const expected = lockedProductionTree();
      installed.packages.delete(
        [...installed.packages].find((entry) => entry.startsWith('@lorepack/cli@')),
      );
      const { missing, unexpected } = compareTrees(
        expected,
        installed.packages,
        optionalPeerNames(),
      );
      for (const entry of missing) problems.push(`tested lockfile has ${entry}, install lacks it`);
      for (const entry of unexpected)
        problems.push(`install has ${entry}, tested lockfile lacks it`);
      if (missing.length === 0 && unexpected.length === 0) {
        console.log(`installed tree equals the ${expected.size}-package tested production tree`);
      }
    }

    const project = join(work, 'project');
    mkdirSync(join(project, 'docs'), { recursive: true });
    copyFileSync(PDF_FIXTURE, join(project, 'docs', 'release-notes.pdf'));
    const hookPath = join(work, 'dlopen-hook.cjs');
    const logPath = join(work, 'dlopen.log');
    writeFileSync(hookPath, DLOPEN_HOOK);
    writeFileSync(logPath, '');
    runInstalledCli(installDir, project, ['init', '.'], hookPath, logPath);
    runInstalledCli(installDir, project, ['build'], hookPath, logPath);
    const search = JSON.parse(
      runInstalledCli(installDir, project, ['search', 'rollback', '--json'], hookPath, logPath),
    );
    const cited = search.hits?.some((hit) => hit.locator?.relativePath?.endsWith('.pdf'));
    if (!cited) problems.push('a PDF build with the installed CLI returned no PDF hit');
    const loaded = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    for (const file of loaded) problems.push(`PDF build loaded native module ${file}`);
    if (cited && loaded.length === 0) console.log('PDF build and search loaded no native module');

    const audit = runTool('npm', ['audit', '--omit=dev', '--json'], installDir, {
      allowFailure: true,
    });
    const report = JSON.parse(audit.stdout);
    const counts = report.metadata?.vulnerabilities;
    if (counts === undefined) {
      problems.push(`npm audit gave no result: ${audit.stdout}${audit.stderr}`.trim());
    } else if (counts.total > 0) {
      problems.push(`npm audit --omit=dev reports ${JSON.stringify(counts)}`);
    } else {
      console.log('npm audit --omit=dev: 0 vulnerabilities');
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error('\ncheck:packed-cli failed. An npm user would not get the tested CLI.\n');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log('check:packed-cli: clean');
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) main();
