import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifySource,
  coverageInventory,
  readFrozenInventory,
} from '../../../scripts/coverage_inventory.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const BASELINE = join(ROOT, 'tools/coverage_inventory/frozen_inventory.json');
let root: string;
const frozen = { included: [{ path: 'src/base.ts', critical: true }] };
const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
function put(path: string, text = 'export const value = 1;'): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lorepack-coverage-inventory-'));
  git(['init', '-q']);
  put('src/base.ts');
  git(['add', '.']);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('all-owned coverage inventory', () => {
  it('includes executable configurations, acceptance drivers and scripts', () => {
    for (const path of [
      'vitest.config.ts',
      'tools/acceptance/src/scenario.ts',
      'scripts/run.mjs',
      'src/component.tsx',
      'src/module.cts',
    ])
      put(path);
    git(['add', '.']);
    const inventory = coverageInventory(root, frozen);
    expect(inventory.included.map((entry) => entry.path)).toEqual([
      'scripts/run.mjs',
      'src/base.ts',
      'src/component.tsx',
      'src/module.cts',
      'tools/acceptance/src/scenario.ts',
      'vitest.config.ts',
    ]);
    expect(inventory.frozenOwned).toBe(1);
    expect(inventory.frozenCritical).toBe(1);
  });

  it('preserves frozen critical flags and extends classification to new sources', () => {
    put('packages/core/src/sql/extra.ts');
    git(['add', '.']);
    const inventory = coverageInventory(root, frozen);
    expect(inventory.included.find((entry) => entry.path === 'src/base.ts')).toMatchObject({
      critical: true,
      frozen: true,
    });
    expect(
      inventory.included.find((entry) => entry.path === 'packages/core/src/sql/extra.ts'),
    ).toMatchObject({ critical: true, frozen: false });
  });

  it('hashes the exact current source bytes', () => {
    put('src/base.ts', 'export const value = 2;\n');
    const entry = coverageInventory(root, frozen).included[0];
    expect(entry?.sha256).toBe(
      createHash('sha256')
        .update(readFileSync(join(root, 'src/base.ts')))
        .digest('hex'),
    );
  });

  it.each([
    ['src/types.d.ts', 'nonexecuted declaration'],
    ['test/unit.ts', 'test or fixture code, not production'],
    ['src/example.test.ts', 'test or fixture code, not production'],
    ['src/example.spec.ts', 'test or fixture code, not production'],
    ['fixtures/document.ts', 'test or fixture code, not production'],
    ['tools/test-support/src/helper.ts', 'test-only support/harness'],
    ['tools/studio-e2e/run.mjs', 'test-only support/harness'],
    ['.specify/scripts/run.js', 'generated specification tooling'],
  ])('records the explicit exclusion of %s', (path, reason) => {
    put(path);
    git(['add', '.']);
    expect(coverageInventory(root, frozen).excluded).toEqual([
      expect.objectContaining({ path, reason }),
    ]);
  });

  it('does not classify documentation as executable', () => {
    expect(classifySource('README.md')).toBeNull();
    put('README.md', 'documentation');
    git(['add', '.']);
    expect(coverageInventory(root, frozen).included).toHaveLength(1);
  });

  it('refuses an omitted frozen source', () => {
    git(['rm', '--cached', '-f', '-q', 'src/base.ts']);
    expect(() => coverageInventory(root, frozen)).toThrow(
      'Frozen owned sources are missing: src/base.ts',
    );
  });

  it('refuses untracked executable sources before reporting a smaller denominator', () => {
    put('scripts/new.mjs');
    expect(() => coverageInventory(root, frozen)).toThrow(
      'Owned sources must be tracked: scripts/new.mjs',
    );
    git(['add', '.']);
    expect(coverageInventory(root, frozen).included).toHaveLength(2);
  });

  it('refuses a tracked source replaced by a directory', () => {
    unlinkSync(join(root, 'src/base.ts'));
    mkdirSync(join(root, 'src/base.ts'));
    expect(() => coverageInventory(root, frozen)).toThrow(
      'Executable source is not a regular file: src/base.ts',
    );
  });

  it.each(['../x.ts', '/x.ts', 'src//x.ts', 'src/./x.ts', 'src/../x.ts', 'src\\x.ts'])(
    'refuses invalid frozen path %s',
    (path) => {
      expect(() => coverageInventory(root, { included: [{ path, critical: false }] })).toThrow(
        'Invalid owned source path',
      );
    },
  );

  it('refuses duplicate frozen records and non-boolean critical flags', () => {
    expect(() =>
      coverageInventory(root, { included: [...frozen.included, ...frozen.included] }),
    ).toThrow('Invalid frozen source record');
    expect(() =>
      coverageInventory(root, { included: [{ path: 'src/base.ts', critical: 'true' }] }),
    ).toThrow('Invalid frozen source record');
  });

  it('refuses test code in the frozen owned set', () => {
    expect(() =>
      coverageInventory(root, { included: [{ path: 'test/unit.ts', critical: false }] }),
    ).toThrow('Invalid frozen source record');
  });

  it('retains the actual audit 345/49 records and detects same-count replacement', () => {
    const baseline = readFrozenInventory(BASELINE);
    expect(baseline.included).toHaveLength(345);
    expect(baseline.included.filter((entry: { critical: boolean }) => entry.critical)).toHaveLength(
      49,
    );
    const altered = JSON.parse(readFileSync(BASELINE, 'utf8'));
    altered.included[0].path = 'src/different.ts';
    const path = join(root, 'changed.json');
    writeFileSync(path, JSON.stringify(altered));
    expect(() => readFrozenInventory(path)).toThrow('frozen source records differ');
    writeFileSync(path, JSON.stringify(frozen));
    expect(() => readFrozenInventory(path)).toThrow('must retain 345 owned and 49 critical');
  });

  it('runs the actual inventory binary with its own source included', () => {
    const output = join(root, 'report.json');
    execFileSync(
      process.execPath,
      [join(ROOT, 'scripts/coverage_inventory.mjs'), '--out', output],
      { cwd: ROOT, stdio: 'pipe' },
    );
    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.frozenOwned).toBe(345);
    expect(report.frozenCritical).toBe(49);
    expect(report.included).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'scripts/coverage_inventory.mjs', frozen: false }),
      ]),
    );
    expect(report.included.length).toBeGreaterThan(345);
    expect(() =>
      execFileSync(process.execPath, [join(ROOT, 'scripts/coverage_inventory.mjs'), '--unknown'], {
        cwd: ROOT,
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
