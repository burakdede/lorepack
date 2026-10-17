import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

describe('published package dependency declarations', () => {
  it('renders ordinary CLI help without initializing protocol SDKs', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('@modelcontextprotocol/'))throw new Error('Ordinary CLI loaded a protocol SDK');
 return next(specifier,context);
}});
const {runCli}=await import('./dist/framework/program.js');
await runCli(['node','lorepack','--help'],{exitProcess:false});
`,
      ],
      { cwd: join(REPO_ROOT, 'packages/cli'), encoding: 'utf8' },
    );
    expect(output).toContain('pack');
    expect(output).toContain('serve');
    expect(output).toContain('mcp');
  });

  it('renders bundled CLI help without initializing protocol SDKs', () => {
    const outputDirectory = mkdtempSync(join(REPO_ROOT, 'packages/cli/.bundle-help-'));
    try {
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "const {bundleCli}=await import('./scripts/bundle-cli.mjs');await bundleCli({output:process.argv[1]});",
          outputDirectory,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('@modelcontextprotocol/'))throw new Error('Bundled CLI loaded a protocol SDK');
 return next(specifier,context);
}});
const entry=process.argv[1];
process.argv=[process.execPath,'lorepack','--help'];
await import(pathToFileURL(entry).href);
`,
          join(outputDirectory, 'public-entry.js'),
        ],
        { cwd: join(REPO_ROOT, 'packages/cli'), encoding: 'utf8' },
      );
      expect(output).toContain('pack');
      expect(output).toContain('serve');
      expect(output).toContain('mcp');
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('loads deployment client operations without loading Worker protocol adapters', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('@modelcontextprotocol/'))throw new Error('Deployment client loaded a protocol adapter');
 return next(specifier,context);
}});
const client=await import('@lorepack/deploy-cloudflare/client');
console.log(JSON.stringify({target:typeof client.createCloudflareDeploymentTarget,retention:typeof client.planRemoteRetention,tokens:typeof client.hashRuntimeToken}));
`,
      ],
      { cwd: join(REPO_ROOT, 'packages/deploy-cloudflare'), encoding: 'utf8' },
    );
    expect(JSON.parse(output)).toEqual({
      target: 'function',
      retention: 'function',
      tokens: 'function',
    });
  });

  it('retains root Worker exports and the same deployment client operations', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
const root=await import('@lorepack/deploy-cloudflare');
const client=await import('@lorepack/deploy-cloudflare/client');
console.log(JSON.stringify({worker:typeof root.createCloudflareWorkerApp,target:root.createCloudflareDeploymentTarget===client.createCloudflareDeploymentTarget,retention:root.planRemoteRetention===client.planRemoteRetention,tokens:root.hashRuntimeToken===client.hashRuntimeToken}));
`,
      ],
      { cwd: join(REPO_ROOT, 'packages/deploy-cloudflare'), encoding: 'utf8' },
    );
    expect(JSON.parse(output)).toEqual({
      worker: 'function',
      target: true,
      retention: true,
      tokens: true,
    });
  });

  it('declares every runtime package imported by compiled JavaScript', () => {
    const problems: string[] = [];

    for (const packageDir of packageDirs()) {
      const manifestPath = join(packageDir, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        private?: boolean;
      };
      if (manifest.private === true) continue;

      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]);

      for (const file of publishedJavaScriptFiles(packageDir, manifest.name)) {
        const source = readFileSync(file, 'utf8');
        for (const specifier of importSpecifiers(source)) {
          if (
            specifier.startsWith('.') ||
            specifier.startsWith('/') ||
            NODE_BUILTINS.has(specifier)
          ) {
            continue;
          }
          const dependency = packageName(specifier);
          if (!declared.has(dependency)) {
            problems.push(
              `${relative(REPO_ROOT, file)} imports ${specifier}, but ${relative(
                REPO_ROOT,
                manifestPath,
              )} does not declare ${dependency}`,
            );
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });
});

function packageDirs(): string[] {
  const packagesRoot = join(REPO_ROOT, 'packages');
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesRoot, entry.name))
    .sort();
}

function javascriptFiles(root: string): string[] {
  if (!existsSync(root)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...javascriptFiles(path));
    } else if (entry.isFile() && path.endsWith('.js')) {
      files.push(path);
    }
  }
  return files.sort();
}

function publishedJavaScriptFiles(packageDir: string, packageName: string | undefined): string[] {
  if (packageName === '@lorepack/cli') {
    const dist = join(packageDir, 'dist');
    const chunks = existsSync(dist)
      ? readdirSync(dist).filter((file) => /^chunk-[A-Z0-9]{8}\.js$/.test(file))
      : [];
    return [
      'public-entry.js',
      'public-index.js',
      'query-child.js',
      'parse-child.js',
      'archive-verify-child.js',
      'build_worker.js',
      ...chunks,
    ]
      .map((file) => join(packageDir, 'dist', file))
      .filter((file) => existsSync(file));
  }
  return javascriptFiles(join(packageDir, 'dist'));
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importFrom = /import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicImport = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const match of source.matchAll(importFrom)) {
    specifiers.push(...match.slice(1, 2));
  }
  for (const match of source.matchAll(dynamicImport)) {
    specifiers.push(...match.slice(1, 2));
  }

  return specifiers;
}

function packageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return `${scope}/${name}`;
  }
  const slash = specifier.indexOf('/');
  return slash === -1 ? specifier : specifier.slice(0, slash);
}
