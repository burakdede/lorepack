#!/usr/bin/env node
// Packs `@lorepack/cli` with its production dependency tree bundled inside the tarball, so an
// npm user installs exactly the tree CI tested rather than a fresh resolution of the ranges.
//
// The tree comes from `pnpm deploy`, which installs the CLI's production closure from the
// frozen workspace lockfile with the workspace overrides applied: `@napi-rs/canvas` removed and
// `mammoth>argparse` pinned. Neither override is part of a published manifest, and npm
// resolves an unbundled optional dependency of `pdfjs-dist` to a native Skia add-on.
//
// Bundling rather than a published `npm-shrinkwrap.json`: npm 12 no longer reads a shrinkwrap
// shipped inside a dependency tarball and points publishers at `bundleDependencies` instead.
// See docs/architecture/release-supply-chain.md.
//
// Usage: node scripts/pack-cli.mjs --out <directory>   (prints the tarball path)
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const BUNDLED_JS = new Set([
  'archive-verify-child.js',
  'build_worker.js',
  'linux_resident_reader_worker.js',
  'parse-child.js',
  'public-entry.js',
  'public-index.js',
  'query-child.js',
  'verify_bridge.js',
]);

function closePublicTypes(root, stage) {
  const context = join(stage, 'dist', 'framework', 'context.d.ts');
  const progress = join(root, 'packages', 'core', 'dist', 'progress', 'events.d.ts');
  const importCore = "import { ProgressBus } from '@lorepack/core';";
  const declaration = readFileSync(context, 'utf8');
  const progressDeclaration = readFileSync(progress, 'utf8');
  if (
    !declaration.startsWith(importCore) ||
    /^\s*(?:import|export).*from\s/m.test(progressDeclaration)
  ) {
    throw new Error('The public CLI progress declaration is no longer self-contained.');
  }
  writeFileSync(
    join(stage, 'dist', 'framework', 'progress-events.d.ts'),
    progressDeclaration.replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, ''),
  );
  writeFileSync(
    context,
    declaration.replace(importCore, "import { ProgressBus } from './progress-events.js';"),
  );
}

function trimPackedDist(stage) {
  const dist = join(stage, 'dist');
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full, relative);
      } else if (
        entry.name.endsWith('.map') ||
        entry.name.endsWith('.tsbuildinfo') ||
        (entry.name.endsWith('.js') &&
          !(BUNDLED_JS.has(relative) || /^chunk-[A-Z0-9]{8}\.js$/.test(relative)))
      ) {
        rmSync(full);
      }
    }
  };
  visit(dist);
}

/** Runs a package-manager command, through the shell only where Windows needs a `.cmd` shim. */
export function runTool(tool, args, cwd, options = {}) {
  const windows = process.platform === 'win32';
  const quoted = windows ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
  const result = spawnSync(windows ? `${tool}.cmd` : tool, quoted, {
    cwd,
    encoding: 'utf8',
    shell: windows,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(
      `${tool} ${args.join(' ')} failed (exit ${result.status}) in ${cwd}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result;
}

/**
 * Copies what `pnpm deploy` reads: the lockfile, workspace and npm configuration, referenced
 * dependency patches, every workspace manifest, and the built CLI.
 *
 * Deploying from a copy rather than from the checkout, because `pnpm deploy` rewrites the
 * workspace's `node_modules/.pnpm-workspace-state-v1.json` with its own production, hoisted
 * settings, after which every `pnpm run` in the checkout believes it needs a reinstall.
 */
export function copyWorkspace(root, target) {
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
    if (existsSync(join(root, file))) copyFileSync(join(root, file), join(target, file));
  }
  if (existsSync(join(root, 'patches'))) {
    cpSync(join(root, 'patches'), join(target, 'patches'), { recursive: true });
  }
  for (const group of ['packages', 'apps', 'tools']) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const manifest = join(root, group, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      mkdirSync(join(target, group, entry.name), { recursive: true });
      copyFileSync(manifest, join(target, group, entry.name, 'package.json'));
    }
  }
  for (const built of ['dist', 'studio-dist']) {
    const source = join(root, 'packages', 'cli', built);
    if (!existsSync(source)) {
      throw new Error(`packages/cli/${built} is missing. Run pnpm build before packing.`);
    }
    cpSync(source, join(target, 'packages', 'cli', built), { recursive: true });
  }
}

export function packCli({ outDir, root = ROOT }) {
  const work = mkdtempSync(join(tmpdir(), 'lorepack-pack-'));
  const workspace = join(work, 'workspace');
  const stage = join(work, 'cli');
  try {
    mkdirSync(workspace);
    copyWorkspace(root, workspace);
    // Injected rather than `--legacy`: the legacy deploy re-resolves every range and drifted
    // 17 packages from the lockfile when tried, while the injected deploy installs from the
    // workspace lockfile. The CLI's workspace dependencies are dev-only and already bundled
    // into dist by esbuild, so injecting them changes nothing that ships. Hoisted, because
    // npm bundles a flat `node_modules` and cannot follow pnpm's symlinked store.
    // Copied, not hardlinked from the store: npm pack crashed with "Exit handler never
    // called" on hardlinked files, which is pnpm's default on Linux and Windows.
    // `CI=true` stops pnpm from asking, on a non-TTY, to purge a modules directory.
    runTool(
      'pnpm',
      [
        '--filter',
        '@lorepack/cli',
        '--prod',
        'deploy',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--config.inject-workspace-packages=true',
        '--config.node-linker=hoisted',
        '--config.package-import-method=copy',
        stage,
      ],
      workspace,
      { env: { CI: 'true' } },
    );

    closePublicTypes(root, stage);
    trimPackedDist(stage);

    const manifestPath = join(stage, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // The workspace devDependencies point at private packages that are never published, and
    // the deployed tree is the full production closure, so every dependency is bundled.
    delete manifest.devDependencies;
    delete manifest.scripts;
    manifest.bundleDependencies = Object.keys(manifest.dependencies ?? {}).sort();
    // npm records `gitHead` only when it packs inside a git checkout, and this stage is not
    // one. The publisher and the registry smoke both require it to equal the release tag's
    // commit (#619).
    manifest.gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    copyFileSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));

    mkdirSync(outDir, { recursive: true });
    const packed = runTool(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', resolve(outDir)],
      stage,
    );
    const report = JSON.parse(packed.stdout);
    const entry = Array.isArray(report) ? report[0] : Object.values(report)[0];
    return join(resolve(outDir), entry.filename);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--out');
  if (index === -1 || args[index + 1] === undefined || args.length !== 2) {
    console.error('usage: pack-cli.mjs --out <directory>');
    process.exit(1);
  }
  console.log(packCli({ outDir: args[index + 1] }));
}
