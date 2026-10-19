import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      mkdirSync(dirname(join(dir, extraFile)), { recursive: true });
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
      dependencies: { 'native-helper': '1.0.0' },
    });
    writeInstalledPackage(root, 'native-helper', { version: '1.0.0' }, ['binding.gyp']);

    expect(checkNoNative(root)).toContain(
      'native add-on (binding.gyp) at node_modules/native-helper',
    );
  });

  it('inspects a dependency whose exports hide its manifest', () => {
    const root = createRepo();
    writeWorkspacePackage(root, 'packages/cli', {
      name: '@lorepack/cli',
      dependencies: { hono: '1.0.0' },
    });
    writeInstalledPackage(
      root,
      'hono',
      {
        exports: { '.': './index.js' },
        scripts: { postinstall: 'node-gyp rebuild' },
      },
      ['index.js', 'binding.gyp'],
    );

    expect(checkNoNative(root)).toContain('native add-on (binding.gyp) at node_modules/hono');
    expect(checkNoNative(root)).toContain(
      'published dependency hono (node_modules/hono) declares a "postinstall" script',
    );
  });

  it('reports a banned optional dependency even when it is absent', () => {
    const root = createRepo();
    writeWorkspacePackage(root, 'packages/cli', {
      name: '@lorepack/cli',
      dependencies: { 'pdfjs-dist': '1.0.0' },
    });
    writeInstalledPackage(root, 'pdfjs-dist', {
      optionalDependencies: { '@napi-rs/canvas': '1.0.0' },
    });

    expect(checkNoNative(root)).toContain(
      'published dependency pdfjs-dist declares banned dependency @napi-rs/canvas',
    );
  });

  it.each<{ manifest: Record<string, unknown>; files: string[]; message: string }>([
    { manifest: { gypfile: true }, files: [], message: 'declares gypfile' },
    { manifest: {}, files: ['prebuilds/platform/binding.node'], message: 'binding.node' },
  ])(
    'detects native artifacts without install hooks ($message)',
    ({ manifest, files, message }) => {
      const root = createRepo();
      writeWorkspacePackage(root, 'packages/cli', {
        name: '@lorepack/cli',
        dependencies: { helper: '1.0.0' },
      });
      writeInstalledPackage(root, 'helper', manifest, files);

      expect(checkNoNative(root).some((problem) => problem.includes(message))).toBe(true);
    },
  );

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
    'reports absent declared %s',
    (field) => {
      const root = createRepo();
      writeWorkspacePackage(root, 'packages/cli', {
        name: '@lorepack/cli',
        [field]: { missing: '1.0.0' },
      });

      expect(checkNoNative(root)).toContain(
        'published dependency @lorepack/cli cannot resolve dependency missing',
      );
    },
  );

  it('inspects required peers and installed optional peers', () => {
    const root = createRepo();
    writeWorkspacePackage(root, 'packages/cli', {
      name: '@lorepack/cli',
      peerDependencies: { required: '1.0.0', optional: '1.0.0', absent: '1.0.0' },
      peerDependenciesMeta: { optional: { optional: true }, absent: { optional: true } },
    });
    writeInstalledPackage(root, 'required', {}, ['binding.gyp']);
    writeInstalledPackage(root, 'optional', {}, ['binding.gyp']);

    expect(checkNoNative(root)).toEqual([
      'native add-on (binding.gyp) at node_modules/optional',
      'native add-on (binding.gyp) at node_modules/required',
    ]);
  });

  it('resolves nested scoped dependencies before hoisted copies', () => {
    const root = createRepo();
    writeWorkspacePackage(root, 'packages/cli', {
      name: '@lorepack/cli',
      dependencies: { parent: '1.0.0' },
    });
    writeInstalledPackage(root, 'parent', { dependencies: { '@scope/helper': '1.0.0' } });
    writeInstalledPackage(root, '@scope/helper', {});
    writeInstalledPackage(packageDir(root, 'parent'), '@scope/helper', {}, ['binding.gyp']);

    expect(checkNoNative(root)).toContain(
      'native add-on (binding.gyp) at node_modules/parent/node_modules/@scope/helper',
    );
  });

  it('inspects declared packages whose names also identify Node builtins', () => {
    const root = createRepo();
    writeWorkspacePackage(root, 'packages/cli', {
      name: '@lorepack/cli',
      dependencies: { string_decoder: '1.0.0' },
    });
    writeInstalledPackage(root, 'string_decoder', {}, ['binding.gyp']);

    expect(checkNoNative(root)).toContain(
      'native add-on (binding.gyp) at node_modules/string_decoder',
    );
  });

  it('follows physical package symlinks once through dependency cycles', () => {
    const root = createRepo();
    writeWorkspacePackage(root, 'packages/cli', {
      name: '@lorepack/cli',
      dependencies: { first: '1.0.0', second: '1.0.0' },
    });
    const store = join(root, '.store');
    writeInstalledPackage(store, 'helper', { dependencies: { helper: '1.0.0' } }, ['binding.gyp']);
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    for (const name of ['first', 'second']) {
      symlinkSync(packageDir(store, 'helper'), packageDir(root, name), 'junction');
    }

    expect(checkNoNative(root)).toEqual([
      'native add-on (binding.gyp) at .store/node_modules/helper',
    ]);
  });

  it('permits only the explicitly removed absent pdfjs canvas optional edge', () => {
    const root = createRepo();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "overrides:\n  '@napi-rs/canvas': '-'\n");
    writeWorkspacePackage(root, 'packages/cli', {
      name: '@lorepack/cli',
      dependencies: { 'pdfjs-dist': '1.0.0' },
    });
    writeInstalledPackage(root, 'pdfjs-dist', {
      optionalDependencies: { '@napi-rs/canvas': '1.0.0' },
    });

    expect(checkNoNative(root)).toEqual([]);

    writeInstalledPackage(root, '@napi-rs/canvas', {});
    expect(checkNoNative(root)).toContain(
      'published dependency closure contains @napi-rs/canvas (node_modules/@napi-rs/canvas)',
    );
  });

  it.each(['dependencies', 'optionalDependencies'])(
    'does not exempt another package declaring removed canvas in %s',
    (field) => {
      const root = createRepo();
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "overrides:\n  '@napi-rs/canvas': '-'\n");
      writeWorkspacePackage(root, 'packages/cli', {
        name: '@lorepack/cli',
        [field]: { '@napi-rs/canvas': '1.0.0' },
      });

      expect(checkNoNative(root)).toContain(
        'published dependency @lorepack/cli declares banned dependency @napi-rs/canvas',
      );
    },
  );
});
