import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkAll,
  checkBareErrors,
  checkManifests,
  checkPackage,
  formatViolations,
} from '../src/check.js';
import { ALLOWED_WORKSPACE_EDGES, PACKAGES } from '../src/rules.js';
import { collectImports } from '../src/scan.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

describe('the real repository', () => {
  it('has no forbidden imports in any package source', () => {
    const violations = checkAll(REPO_ROOT);
    expect(formatViolations(violations)).toBe('');
  });

  it('has no forbidden workspace dependency declared in any manifest', () => {
    const violations = checkManifests(REPO_ROOT);
    expect(formatViolations(violations)).toBe('');
  });

  it('encodes exactly the edges from architecture section 9.1', () => {
    expect(ALLOWED_WORKSPACE_EDGES.core).toEqual([]);
    expect(ALLOWED_WORKSPACE_EDGES.compiler).toEqual(['core', 'parsers']);
    expect(ALLOWED_WORKSPACE_EDGES.cli).toContain('parsers');
    // The runtime reaches storage only through the ports in `core`. Phase 6 supplies
    // different ports over D1 and R2, and an edge to a backend would make that a hope
    // rather than something the build refuses to break (#41).
    expect(ALLOWED_WORKSPACE_EDGES.runtime).toEqual(['core']);
    expect(ALLOWED_WORKSPACE_EDGES.mcp).toEqual(['core', 'runtime']);
    expect(ALLOWED_WORKSPACE_EDGES.sdk).toEqual([]);
  });

  it('covers every package that exists on disk', () => {
    expect(new Set(PACKAGES)).toEqual(new Set(Object.keys(ALLOWED_WORKSPACE_EDGES)));
  });
});

describe('violation detection', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lore-arch-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (pkg: string, file: string, contents: string): void => {
    const dir = join(root, 'packages', pkg, 'src');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), contents, 'utf8');
  };

  it('rejects core importing node:sqlite', () => {
    write(
      'core',
      'bad.ts',
      "import { DatabaseSync } from 'node:sqlite';\nexport const x = DatabaseSync;\n",
    );
    const violations = checkPackage(root, 'core');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe('node:sqlite');
    expect(violations[0]?.file).toBe('packages/core/src/bad.ts');
  });

  it.each([
    ['core', "import 'hono';"],
    ['core', "import { useState } from 'react';"],
    ['core', "import { Client } from '@modelcontextprotocol/client';"],
    ['parsers', "import { DatabaseSync } from 'node:sqlite';"],
    ['sdk', "import { Hono } from 'hono';"],
  ] as const)('rejects %s importing a forbidden module', (pkg, source) => {
    write(pkg, 'bad.ts', `${source}\nexport const x = 1;\n`);
    expect(checkPackage(root, pkg).length).toBeGreaterThan(0);
  });

  it('rejects an upward workspace import', () => {
    write(
      'core',
      'bad.ts',
      "import { compile } from '@lorepack/compiler';\nexport const x = compile;\n",
    );
    const violations = checkPackage(root, 'core');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toContain('may not import @lorepack/compiler');
  });

  it('allows a permitted workspace import', () => {
    write(
      'compiler',
      'ok.ts',
      "import type { Artifact } from '@lorepack/core';\nexport type X = Artifact;\n",
    );
    expect(checkPackage(root, 'compiler')).toEqual([]);
  });

  it('detects dynamic import, require, and re-export forms', () => {
    write('core', 'a.ts', "export const load = () => import('node:sqlite');\n");
    write('core', 'b.ts', "export * from 'hono';\n");
    write('core', 'c.ts', "const h = require('react');\nexport default h;\n");
    expect(checkPackage(root, 'core')).toHaveLength(3);
  });

  it('ignores specifiers that only appear inside comments', () => {
    write(
      'core',
      'ok.ts',
      "// import { DatabaseSync } from 'node:sqlite';\n/* import 'hono'; */\nexport const x = 1;\n",
    );
    expect(checkPackage(root, 'core')).toEqual([]);
  });

  it('reports the offending file, line, specifier, and the rule broken', () => {
    write('core', 'bad.ts', "export const a = 1;\nimport 'hono';\n");
    const message = formatViolations(checkPackage(root, 'core'));
    expect(message).toContain('packages/core/src/bad.ts');
    expect(message).toContain('hono');
    expect(message).toContain('Architecture section 9.1');
  });

  it('rejects a forbidden dependency declared in a manifest', () => {
    const dir = join(root, 'packages', 'core');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@lorepack/core',
        dependencies: { '@lorepack/runtime': 'workspace:*' },
      }),
      'utf8',
    );
    const violations = checkManifests(root);
    expect(violations.some((v) => v.specifier === '@lorepack/runtime')).toBe(true);
  });
});

describe('import scanning', () => {
  it('records line numbers relative to the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'lore-scan-'));
    const dir = join(root, 'src');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.ts'), "const a = 1;\nconst b = 2;\nimport 'hono';\n", 'utf8');
    const records = collectImports(dir, root);
    expect(records[0]?.line).toBe(3);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('bare error rule', () => {
  it('the real repository throws no bare Error in user-facing packages', () => {
    expect(formatViolations(checkBareErrors(REPO_ROOT))).toBe('');
  });

  it('detects a bare throw', () => {
    const root = mkdtempSync(join(tmpdir(), 'lore-bare-'));
    const dir = join(root, 'packages', 'core', 'src');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'bad.ts'),
      'export function f() {\n  throw new Error("nope");\n}\n',
      'utf8',
    );
    const violations = checkBareErrors(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.rule).toContain('LoreError');
    rmSync(root, { recursive: true, force: true });
  });
});
