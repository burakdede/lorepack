import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareTrees,
  inspectInstalledTree,
  optionalPeerNames,
} from '../../../scripts/check-packed-cli.mjs';

/**
 * The pure halves of `check:packed-cli`: reading an npm-installed tree and comparing it to the
 * tested lockfile. The npm install itself runs in the `packed install` CI job, because it needs
 * the network.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

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
