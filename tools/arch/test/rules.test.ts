import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { ALLOWED_WORKSPACE_EDGES, PACKAGE_DIRS, PACKAGES } from '../src/rules.js';
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

  it('checks every package and app directory, so a new one cannot go unchecked', () => {
    const onDisk = ['packages', 'apps'].flatMap((parent) =>
      readdirSync(join(REPO_ROOT, parent), { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() && existsSync(join(REPO_ROOT, parent, entry.name, 'package.json')),
        )
        .map((entry) => `${parent}/${entry.name}`),
    );
    expect(new Set(Object.values(PACKAGE_DIRS))).toEqual(new Set(onDisk));
  });

  it('reads the real sources, so a clean result is not an empty one', () => {
    const core = collectImports(join(REPO_ROOT, 'packages', 'core', 'src'), REPO_ROOT);
    const studio = collectImports(join(REPO_ROOT, 'apps', 'studio', 'src'), REPO_ROOT);
    expect(core.some((record) => record.specifier === 'zod')).toBe(true);
    expect(studio.some((record) => record.specifier === '@lorepack/sdk')).toBe(true);
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

  // The five bypasses from #617. Each passed the regex scanner, `tsc` and Biome.
  it('rejects a multi-line import', () => {
    write(
      'core',
      'bad.ts',
      "import {\n  DatabaseSync as Db,\n} from 'node:sqlite';\nexport const x = Db;\n",
    );
    const violations = checkPackage(root, 'core');
    expect(violations.map((v) => [v.specifier, v.line])).toEqual([['node:sqlite', 3]]);
  });

  it('rejects a multi-line re-export and a multi-line dynamic import', () => {
    write('core', 'a.ts', "export {\n  Hono,\n} from 'hono';\n");
    write('core', 'b.ts', "export const load = () =>\n  import(\n    'node:sqlite'\n  );\n");
    expect(checkPackage(root, 'core').map((v) => v.specifier)).toEqual(['hono', 'node:sqlite']);
  });

  it.each([
    ["export const db = process.getBuiltinModule('node:sqlite');\n"],
    ["const { getBuiltinModule } = process;\nexport const db = getBuiltinModule('node:sqlite');\n"],
    ["export const db = process['getBuiltinModule']('node:sqlite');\n"],
    [
      "import { createRequire } from 'node:module';\nexport const db = createRequire(import.meta.url)('node:sqlite');\n",
    ],
  ])('rejects a module loaded by name: %s', (source) => {
    write('core', 'bad.ts', source);
    const violations = checkPackage(root, 'core');
    expect(violations.some((v) => v.rule.includes('does not spell out'))).toBe(true);
  });

  it.each([
    ["const name = 'node:sqlite';\nexport const load = () => import(name);\n"],
    [`export const load = (name: string) => import(\`node:\${name}\`);\n`],
    ["const name = 'hono';\nexport const h = require(name);\n"],
    ["export const h = module.require('hono' + '');\n"],
  ])('rejects a computed specifier: %s', (source) => {
    write('core', 'bad.ts', source);
    expect(checkPackage(root, 'core').some((v) => v.rule.includes('does not spell out'))).toBe(
      true,
    );
  });

  it.each([
    ["export * from '../../backend-local/src/index.js';\n"],
    ["import { x } from '../../../packages/runtime/src/index.js';\nexport { x };\n"],
    ["export const load = () => import('../../mcp/src/server.js');\n"],
    ["export * from '/etc/lorepack/index.js';\n"],
    ["export * from 'file:///tmp/index.js';\n"],
  ])('rejects a path that leaves the package: %s', (source) => {
    write('core', 'bad.ts', source);
    const violations = checkPackage(root, 'core');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toContain('outside packages/core');
  });

  it('allows a relative import that stays inside the package', () => {
    write('core', 'a.ts', 'export const a = 1;\n');
    mkdirSync(join(root, 'packages', 'core', 'src', 'nested'), { recursive: true });
    write(
      'core',
      'nested/b.ts',
      "export { a } from '../a.js';\nexport * from '../../package.json';\n",
    );
    expect(checkPackage(root, 'core')).toEqual([]);
  });

  it('checks apps/studio, which only reaches the runtime over HTTP through the SDK', () => {
    const dir = join(root, 'apps', 'studio', 'src');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'bad.tsx'),
      [
        "import { createClient } from '@lorepack/sdk';",
        "import { openBuild } from '@lorepack/backend-local';",
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'path';",
        'export const App = () => <div>{String(createClient)}{String(openBuild)}{String(readFileSync)}{join}</div>;',
        '',
      ].join('\n'),
      'utf8',
    );
    expect(checkPackage(root, 'studio').map((v) => v.specifier)).toEqual([
      '@lorepack/backend-local',
      'node:fs',
      'path',
    ]);
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
