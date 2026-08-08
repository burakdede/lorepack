import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkNoNative } from '../../../scripts/check-no-native.mjs';

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function packageDir(root: string, name: string): string {
  return join(root, 'node_modules', ...name.split('/'));
}

describe('check:no-native', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'lore-no-native-'));
    roots.push(root);
    writeJson(join(root, 'package.json'), { name: 'lorepack', private: true });
    return root;
  }

  function writeWorkspacePackage(
    root: string,
    relDir: string,
    manifest: Record<string, unknown>,
  ): void {
    writeJson(join(root, relDir, 'package.json'), manifest);
  }

  function writeInstalledPackage(
    root: string,
    name: string,
    manifest: Record<string, unknown>,
    extraFiles: string[] = [],
  ): void {
    const dir = packageDir(root, name);
    writeJson(join(dir, 'package.json'), { name, ...manifest });
    for (const extraFile of extraFiles) {
      writeFileSync(join(dir, extraFile), '', 'utf8');
    }
  }

  it('ignores root-only dev tooling outside the published dependency closure', () => {
    const root = createRepo();
    writeJson(join(root, 'package.json'), {
      name: 'lorepack',
      private: true,
      devDependencies: { wrangler: '4.119.0' },
    });
    writeWorkspacePackage(root, 'packages/cli', {
      name: '@lorepack/cli',
      version: '0.0.0',
      dependencies: { hono: '4.12.33' },
    });
    writeInstalledPackage(root, 'hono', { version: '4.12.33' });
    writeInstalledPackage(root, 'wrangler', {
      version: '4.119.0',
      dependencies: { sharp: '1.0.0' },
    });
    writeInstalledPackage(root, 'sharp', { version: '1.0.0' });

    expect(checkNoNative(root)).toEqual([]);
  });

  it('fails when a published package reaches a banned native dependency', () => {
    const root = createRepo();
    writeWorkspacePackage(root, 'packages/cli', {
      name: '@lorepack/cli',
      version: '0.0.0',
      dependencies: { wrangler: '4.119.0' },
    });
    writeInstalledPackage(root, 'wrangler', {
      version: '4.119.0',
      dependencies: { sharp: '1.0.0' },
    });
    writeInstalledPackage(root, 'sharp', { version: '1.0.0' });

    expect(checkNoNative(root)).toContain(
      'published dependency closure contains sharp (node_modules/sharp)',
    );
  });

  it('fails when a published dependency declares an install hook', () => {
    const root = createRepo();
    writeWorkspacePackage(root, 'packages/cli', {
      name: '@lorepack/cli',
      version: '0.0.0',
      dependencies: { deployer: '1.0.0' },
    });
    writeInstalledPackage(root, 'deployer', {
      version: '1.0.0',
      scripts: { postinstall: 'node setup.js' },
    });

    expect(checkNoNative(root)).toContain(
      'published dependency deployer (node_modules/deployer) declares a "postinstall" script',
    );
  });

  it('fails when a published dependency ships a binding.gyp', () => {
    const root = createRepo();
    writeWorkspacePackage(root, 'packages/cli', {
      name: '@lorepack/cli',
      version: '0.0.0',
      dependencies: { native-helper: '1.0.0' },
    });
    writeInstalledPackage(root, 'native-helper', { version: '1.0.0' }, ['binding.gyp']);

    expect(checkNoNative(root)).toContain(
      'native add-on (binding.gyp) at node_modules/native-helper',
    );
  });
});
