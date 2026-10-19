#!/usr/bin/env node
// Guards the zero-surprise install promise: no native add-ons, no install scripts.
// See AGENTS.md section 9 and architecture section 6.1.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BANNED_PACKAGES = [
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
const WORKSPACE_DIRS = ['packages', 'apps', 'tools'];

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function formatPath(rootDir, fullPath) {
  const rel = relative(realpathSync.native(rootDir), realpathSync.native(fullPath));
  const shown = rel === '' || rel.startsWith('..') ? fullPath : rel;
  return shown.replaceAll('\\', '/');
}

function listWorkspaceManifestFiles(rootDir) {
  const files = [];
  const rootManifest = join(rootDir, 'package.json');
  if (existsSync(rootManifest)) files.push(rootManifest);

  for (const workspaceDir of WORKSPACE_DIRS) {
    const parent = join(rootDir, workspaceDir);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent)) {
      const manifest = join(parent, entry, 'package.json');
      if (existsSync(manifest)) files.push(manifest);
    }
  }

  return files;
}

function readWorkspacePackages(rootDir) {
  return listWorkspaceManifestFiles(rootDir).map((manifestPath) => {
    const manifest = readJson(manifestPath);
    return {
      manifest,
      manifestPath,
      dir: dirname(manifestPath),
      relativePath: formatPath(rootDir, manifestPath),
    };
  });
}

function hasInstallHook(manifest) {
  return INSTALL_HOOKS.find((hook) => manifest.scripts?.[hook]);
}

function inspectInstalledPackage(rootDir, packageDir, manifest, problems) {
  if (BANNED_PACKAGES.includes(manifest.name)) {
    problems.push(
      `published dependency closure contains ${manifest.name} (${formatPath(rootDir, packageDir)})`,
    );
  }

  const hook = hasInstallHook(manifest);
  if (hook) {
    problems.push(
      `published dependency ${manifest.name} (${formatPath(rootDir, packageDir)}) declares a "${hook}" script`,
    );
  }

  if (existsSync(join(packageDir, 'binding.gyp'))) {
    problems.push(`native add-on (binding.gyp) at ${formatPath(rootDir, packageDir)}`);
  }

  if (manifest.gypfile === true) {
    problems.push(`published dependency ${manifest.name} declares gypfile`);
  }

  function inspectFiles(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') inspectFiles(file);
      else if (entry.isFile() && entry.name.endsWith('.node')) {
        problems.push(`native add-on (.node) at ${formatPath(rootDir, file)}`);
      }
    }
  }
  inspectFiles(packageDir);
}

function dependencyEdges(manifest) {
  const edges = new Map();
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    edges.set(name, {
      name,
      optionalPeer: manifest.peerDependenciesMeta?.[name]?.optional === true,
    });
  }
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    edges.set(name, { name });
  }
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
    edges.set(name, { name, optional: true });
  }
  return edges.values();
}

function resolveDependencyPackage(rootDir, packageDir, dependencyName, workspaceByName) {
  const lookupDirs = [];
  for (let dir = realpathSync.native(packageDir); ; dir = dirname(dir)) {
    if (basename(dir) !== 'node_modules') lookupDirs.push(join(dir, 'node_modules'));
    if (dirname(dir) === dir) break;
  }
  for (const lookupDir of lookupDirs) {
    const candidate = join(lookupDir, dependencyName, 'package.json');
    if (!existsSync(candidate)) continue;
    const manifestPath = realpathSync.native(candidate);
    return {
      manifest: readJson(manifestPath),
      manifestPath,
      dir: dirname(manifestPath),
      relativePath: formatPath(rootDir, manifestPath),
    };
  }
  return workspaceByName.get(dependencyName) ?? null;
}

function walkPublishedClosure(rootDir, pkg, workspaceByName, seen, problems, removesCanvas) {
  const key = realpathSync.native(pkg.manifestPath);
  if (seen.has(key)) return;
  seen.add(key);

  inspectInstalledPackage(rootDir, pkg.dir, pkg.manifest, problems);

  for (const edge of dependencyEdges(pkg.manifest)) {
    const dependencyName = edge.name;
    const resolvedDependency = resolveDependencyPackage(
      rootDir,
      pkg.dir,
      dependencyName,
      workspaceByName,
    );
    if (
      !resolvedDependency &&
      removesCanvas &&
      edge.optional &&
      pkg.manifest.name === 'pdfjs-dist' &&
      dependencyName === '@napi-rs/canvas'
    )
      continue;
    if (BANNED_PACKAGES.includes(dependencyName)) {
      problems.push(
        `published dependency ${pkg.manifest.name} declares banned dependency ${dependencyName}`,
      );
    }
    if (!resolvedDependency) {
      if (!edge.optionalPeer) {
        problems.push(
          `published dependency ${pkg.manifest.name} cannot resolve dependency ${dependencyName}`,
        );
      }
      continue;
    }
    walkPublishedClosure(
      rootDir,
      resolvedDependency,
      workspaceByName,
      seen,
      problems,
      removesCanvas,
    );
  }
}

export function checkNoNative(rootDir = process.cwd()) {
  const problems = [];
  const workspaceConfig = join(rootDir, 'pnpm-workspace.yaml');
  let removesCanvas = false;
  if (existsSync(workspaceConfig)) {
    const { parse } = createRequire(new URL('../packages/cli/package.json', import.meta.url))(
      'yaml',
    );
    removesCanvas =
      parse(readFileSync(workspaceConfig, 'utf8'))?.overrides?.['@napi-rs/canvas'] === '-';
  }
  const workspacePackages = readWorkspacePackages(rootDir);

  for (const pkg of workspacePackages) {
    const hook = hasInstallHook(pkg.manifest);
    if (hook) problems.push(`${pkg.relativePath}: declares a "${hook}" script`);
  }

  const workspaceByName = new Map(
    workspacePackages
      .filter((pkg) => typeof pkg.manifest.name === 'string' && pkg.manifest.name.length > 0)
      .map((pkg) => [pkg.manifest.name, pkg]),
  );
  const publishablePackages = workspacePackages.filter(
    (pkg) => pkg.relativePath !== 'package.json' && pkg.manifest.private !== true,
  );
  const seen = new Set();

  for (const pkg of publishablePackages) {
    walkPublishedClosure(rootDir, pkg, workspaceByName, seen, problems, removesCanvas);
  }

  return problems.sort((a, b) => a.localeCompare(b));
}

function main() {
  const problems = checkNoNative();

  if (problems.length > 0) {
    console.error(
      'check:no-native failed. A user install must never compile or download binaries.\n',
    );
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }

  console.log('check:no-native: clean');
}

const executedAsScript =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (executedAsScript) {
  main();
}
