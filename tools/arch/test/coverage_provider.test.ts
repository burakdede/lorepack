import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Coverage = {
  path: string;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
  fnMap: Record<string, { loc: { start: { line: number } } }>;
  branchMap: Record<string, { loc: { start: { line: number } } }>;
};

let root: string;
let maps: Record<string, Coverage>;

beforeAll(() => {
  const repository = resolve(import.meta.dirname, '../../..');
  const require = createRequire(join(repository, 'package.json'));
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  mkdirSync(join(repository, 'coverage'), { recursive: true });
  root = realpathSync(mkdtempSync(join(repository, 'coverage/provider-')));
  writeFileSync(
    join(root, 'private.ts'),
    `export class PrivateWitness {
  #used(value: number) {
    return value + 1;
  }
  #unused() {
    throw new Error('Never called');
  }
  async #choose(value: boolean) {
    await Promise.resolve();
    if (value) return 'yes';
    return 'no';
  }
  async run(value: boolean) {
    return [this.#used(1), await this.#choose(value)];
  }
}
`,
  );
  writeFileSync(join(root, 'empty.ts'), 'export interface OnlyType { value: string; }\n');
  writeFileSync(join(root, 'barrel.ts'), "export type { OnlyType } from './empty.ts';\n");
  writeFileSync(
    join(root, 'witness.test.ts'),
    `import { expect, test } from 'vitest';
import { PrivateWitness } from './private.ts';
test('executes both async branch arms', async () => {
  const instance = new PrivateWitness();
  expect(await instance.run(true)).toEqual([2, 'yes']);
  expect(await instance.run(false)).toEqual([2, 'no']);
});
`,
  );
  writeFileSync(
    join(root, 'vitest.config.mjs'),
    `export default ${JSON.stringify({
      root,
      test: {
        include: ['witness.test.ts'],
        coverage: {
          provider: 'istanbul',
          enabled: true,
          include: ['private.ts', 'empty.ts', 'barrel.ts'],
          exclude: [],
          reporter: ['json'],
          reportsDirectory: 'coverage',
        },
      },
    })};\n`,
  );
  execFileSync(process.execPath, [vitest, 'run', '--config', join(root, 'vitest.config.mjs')], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const raw: Record<string, Coverage> = JSON.parse(
    readFileSync(join(root, 'coverage/coverage-final.json'), 'utf8'),
  );
  maps = Object.fromEntries(
    Object.entries(raw).map(([path, map]) => {
      const canonical = realpathSync(path);
      expect(realpathSync(map.path)).toBe(canonical);
      return [canonical, map];
    }),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('instrumented coverage source retention', () => {
  it('counts exercised and unused private methods, including async methods', () => {
    const map = maps[join(root, 'private.ts')];
    if (!map) throw new Error('Missing executed source map.');
    const functions = Object.entries(map.fnMap).map(([id, fn]) => ({
      line: fn.loc.start.line,
      hits: map.f[id],
    }));
    expect(functions).toEqual(
      expect.arrayContaining([
        { line: 2, hits: 2 },
        { line: 5, hits: 0 },
        { line: 8, hits: 2 },
        { line: 13, hits: 2 },
      ]),
    );
    const branch = Object.entries(map.branchMap).find(([, value]) => value.loc.start.line === 10);
    if (!branch) throw new Error('Missing async branch counter.');
    expect(map.b[branch[0]]).toEqual([1, 1]);
  });

  it('retains real type-only and barrel records without inventing counters', () => {
    expect(Object.keys(maps).sort()).toEqual(
      ['barrel.ts', 'empty.ts', 'private.ts'].map((file) => join(root, file)).sort(),
    );
    for (const file of ['barrel.ts', 'empty.ts']) {
      const path = join(root, file);
      expect(maps[path]?.s).toEqual({});
      expect(maps[path]?.f).toEqual({});
      expect(maps[path]?.b).toEqual({});
    }
  });
});
