import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

describe('published package dependency declarations', () => {
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

      for (const file of javascriptFiles(join(packageDir, 'dist'))) {
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

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importFrom = /import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicImport = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const match of source.matchAll(importFrom)) {
    specifiers.push(match[1]);
  }
  for (const match of source.matchAll(dynamicImport)) {
    specifiers.push(match[1]);
  }

  return specifiers;
}

function packageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return `${scope}/${name}`;
  }
  return specifier.split('/')[0];
}
