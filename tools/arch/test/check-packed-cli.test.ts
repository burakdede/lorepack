import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareTrees,
  inspectInstalledTree,
  optionalPeerNames,
} from '../../../scripts/check-packed-cli.mjs';
import { copyWorkspace } from '../../../scripts/pack-cli.mjs';
import {
  compareMembers,
  parseMembers,
  readReviewedMembers,
} from '../../../scripts/packed-cli-members.mjs';

/**
 * The npm install itself runs in the `packed install` CI job, because it needs the network.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

describe('packed CLI staging workspace', () => {
  it('copies an actual referenced dependency patch with identical bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'lore-pack-input-'));
    const staged = mkdtempSync(join(tmpdir(), 'lore-pack-staged-'));
    try {
      for (const group of ['packages', 'apps', 'tools']) {
        mkdirSync(join(root, group), { recursive: true });
      }
      const patchPath = 'patches/@vitest__coverage-istanbul@4.1.11.patch';
      const patchBytes = Buffer.from('diff --git a/index.js b/index.js\n');
      writeFileSync(join(root, 'package.json'), '{}\n');
      writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      writeFileSync(
        join(root, 'pnpm-workspace.yaml'),
        `patchedDependencies:\n  '@vitest/coverage-istanbul@4.1.11': ${patchPath}\n`,
      );
      mkdirSync(dirname(join(root, patchPath)), { recursive: true });
      writeFileSync(join(root, patchPath), patchBytes);
      writeJson(join(root, 'packages', 'cli', 'package.json'), { name: '@lorepack/cli' });
      mkdirSync(join(root, 'packages', 'cli', 'dist'));
      mkdirSync(join(root, 'packages', 'cli', 'studio-dist'));

      copyWorkspace(root, staged);

      expect(readFileSync(join(staged, patchPath))).toEqual(patchBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(staged, { recursive: true, force: true });
    }
  });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

describe('inspectInstalledTree', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function tree(): string {
    const root = mkdtempSync(join(tmpdir(), 'lore-packed-'));
    roots.push(root);
    return join(root, 'node_modules');
  }

  it('lists every package, including bundled and scoped ones, as name@version', () => {
    const nodeModules = tree();
    writeJson(join(nodeModules, '@lorepack', 'cli', 'package.json'), {
      name: '@lorepack/cli',
      version: '0.1.0',
    });
    writeJson(join(nodeModules, '@lorepack', 'cli', 'node_modules', 'mammoth', 'package.json'), {
      name: 'mammoth',
      version: '1.12.0',
    });
    writeJson(
      join(
        nodeModules,
        '@lorepack',
        'cli',
        'node_modules',
        'mammoth',
        'node_modules',
        'argparse',
        'package.json',
      ),
      { name: 'argparse', version: '2.0.1' },
    );

    const result = inspectInstalledTree(nodeModules);

    expect([...result.packages].sort()).toEqual([
      '@lorepack/cli@0.1.0',
      'argparse@2.0.1',
      'mammoth@1.12.0',
    ]);
    expect(result.problems).toEqual([]);
  });

  it('reports the optional native canvas that pdfjs-dist pulls in under npm', () => {
    // The shape #603 found: npm resolves pdfjs-dist's optional `@napi-rs/canvas`, which the
    // workspace override removes but a published manifest cannot.
    const nodeModules = tree();
    writeJson(join(nodeModules, '@napi-rs', 'canvas', 'package.json'), {
      name: '@napi-rs/canvas',
      version: '1.0.10',
    });
    const platform = join(nodeModules, '@napi-rs', 'canvas-darwin-arm64');
    writeJson(join(platform, 'package.json'), {
      name: '@napi-rs/canvas-darwin-arm64',
      version: '1.0.10',
    });
    writeFileSync(join(platform, 'skia.darwin-arm64.node'), '');

    const { problems } = inspectInstalledTree(nodeModules);

    expect(problems).toEqual([
      'native add-on @napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node',
      'native package @napi-rs/canvas installed at @napi-rs/canvas',
      'native package @napi-rs/canvas-darwin-arm64 installed at @napi-rs/canvas-darwin-arm64',
    ]);
  });

  it('finds a .node file deep inside an otherwise ordinary package', () => {
    const nodeModules = tree();
    writeJson(join(nodeModules, 'innocent', 'package.json'), {
      name: 'innocent',
      version: '1.0.0',
    });
    mkdirSync(join(nodeModules, 'innocent', 'build', 'Release'), { recursive: true });
    writeFileSync(join(nodeModules, 'innocent', 'build', 'Release', 'addon.node'), '');

    expect(inspectInstalledTree(nodeModules).problems).toEqual([
      'native add-on innocent/build/Release/addon.node',
    ]);
  });

  it('treats a missing node_modules as an empty tree', () => {
    expect(inspectInstalledTree(tree()).packages.size).toBe(0);
  });
});

describe('compareTrees', () => {
  it('names what drifted in each direction', () => {
    const expected = new Set(['zod@4.4.3', 'jszip@3.10.1', 'argparse@2.0.1']);
    const installed = new Set(['zod@4.6.5', 'jszip@3.10.1', 'argparse@1.0.10']);

    expect(compareTrees(expected, installed)).toEqual({
      missing: ['argparse@2.0.1', 'zod@4.4.3'],
      unexpected: ['argparse@1.0.10', 'zod@4.6.5'],
    });
  });

  it('excuses an optional peer the workspace resolved and a user install leaves out', () => {
    const expected = new Set(['debug@4.4.3', 'supports-color@10.2.2']);
    const installed = new Set(['debug@4.4.3']);

    expect(compareTrees(expected, installed, new Set(['supports-color']))).toEqual({
      missing: [],
      unexpected: [],
    });
  });

  it('never excuses an optional peer that arrives at a different version', () => {
    const expected = new Set(['supports-color@10.2.2']);
    const installed = new Set(['supports-color@9.0.0']);

    expect(compareTrees(expected, installed, new Set(['supports-color'])).unexpected).toEqual([
      'supports-color@9.0.0',
    ]);
  });
});

describe('optionalPeerNames', () => {
  it('reads optional peers from the workspace lockfile', () => {
    expect(readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8')).toContain('supports-color');
    expect(optionalPeerNames(REPO_ROOT).has('supports-color')).toBe(true);
  });
});

describe('packed CLI member allow-list', () => {
  it('rejects an extra CLI file and a missing dependency file', () => {
    const expected = parseMembers(
      'package/LICENSE\npackage/dist/public-entry.js\npackage/node_modules/zod/package.json\n',
      'reviewed allow-list',
    ).members;
    const actual = parseMembers(
      'package/LICENSE\npackage/dist/public-entry.js\npackage/dist/private-fixture.txt\n',
      'packed tarball',
    ).members;

    expect(compareMembers(expected, actual)).toEqual([
      'unexpected tarball member: package/dist/private-fixture.txt',
      'missing tarball member: package/node_modules/zod/package.json',
    ]);
  });

  it('rejects duplicate and unsafe tar names before comparing membership', () => {
    const listed = parseMembers(
      'package/dist/public-entry.js\npackage/dist/public-entry.js\npackage/../outside\n/package/absolute\npackage\\windows\n',
      'packed tarball',
    );

    expect(listed.problems).toEqual([
      'packed tarball: duplicate tarball member package/dist/public-entry.js',
      'packed tarball: unsafe tarball member "package/../outside"',
      'packed tarball: unsafe tarball member "/package/absolute"',
      'packed tarball: unsafe tarball member "package\\\\windows"',
    ]);
  });

  it('requires a reviewed, sorted full-path manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'lore-members-'));
    try {
      const path = join(root, 'members.txt');
      writeFileSync(path, 'package/LICENSE\npackage/dist/public-entry.js\n');
      expect([...readReviewedMembers(path)]).toEqual([
        'package/LICENSE',
        'package/dist/public-entry.js',
      ]);
      writeFileSync(path, 'package/dist/public-entry.js\npackage/LICENSE\n');
      expect(() => readReviewedMembers(path)).toThrow('sorted paths');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('packed CLI member proposal command', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'lore-member-proposal-'));
    roots.push(root);
    mkdirSync(join(root, 'package'));
    writeFileSync(join(root, 'package', 'z.txt'), 'last');
    writeFileSync(join(root, 'package', 'a.txt'), 'first');
    const tarball = join(root, 'fixture.tgz');
    const output = join(root, 'proposal.txt');
    const packed = spawnSync(
      'tar',
      ['-czf', tarball, '-C', root, 'package/z.txt', 'package/a.txt'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(packed.error).toBeUndefined();
    expect(packed.signal).toBeNull();
    expect(packed.status, packed.stderr).toBe(0);
    return { root, tarball, output };
  }

  function propose(root: string, args: string[]) {
    return spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'propose-packed-cli-members.mjs'), ...args],
      { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 },
    );
  }

  it('writes sorted full paths with one final LF from a real tarball', () => {
    const { root, tarball, output } = fixture();
    const result = propose(root, ['--tarball', tarball, '--out', output]);

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('wrote 2 proposed member paths for review\n');
    expect(readFileSync(output)).toEqual(Buffer.from('package/a.txt\npackage/z.txt\n'));
  });

  it('refuses to replace an existing proposal and preserves its bytes', () => {
    const { root, tarball, output } = fixture();
    const args = ['--tarball', tarball, '--out', output];
    const initial = propose(root, args);
    expect(initial.error).toBeUndefined();
    expect(initial.signal).toBeNull();
    expect(initial.status, initial.stderr).toBe(0);
    const before = readFileSync(output);
    const result = propose(root, args);

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('EEXIST');
    expect(readFileSync(output)).toEqual(before);
  });

  it.each(['missing output flag', 'reordered flags'])(
    'rejects %s without creating a proposal',
    (variant) => {
      const { root, tarball, output } = fixture();
      const args =
        variant === 'missing output flag'
          ? ['--tarball', tarball]
          : ['--out', output, '--tarball', tarball];
      const result = propose(root, args);

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        'usage: propose-packed-cli-members.mjs --tarball <tgz> --out <new file>\n',
      );
      expect(existsSync(output)).toBe(false);
    },
  );

  it('rejects an invalid tarball without creating a proposal', () => {
    const { root, output } = fixture();
    const invalid = join(root, 'invalid.tgz');
    writeFileSync(invalid, 'not a gzip tarball\n');
    const result = propose(root, ['--tarball', invalid, '--out', output]);

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('tar -tzf');
    expect(result.stderr).toContain('failed (exit ');
    expect(existsSync(output)).toBe(false);
  });
});
