import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderCoverageConfig } from '../../../scripts/coverage_configuration.mjs';
import { prepareNativeCapture } from '../../../scripts/coverage_instrumented.mjs';

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
    renderCoverageConfig(
      {
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
      },
      {
        snapshot: {
          root,
          included: ['private.ts', 'empty.ts', 'barrel.ts'].map((path) => ({
            path,
            sha256: createHash('sha256')
              .update(readFileSync(join(root, path)))
              .digest('hex'),
          })),
        },
        directory: join(root, 'preparations'),
      },
    ),
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

describe('pinned native instrumentation primitives', () => {
  it('records actual initializer, private-method and early-throw execution', async () => {
    const repository = resolve(import.meta.dirname, '../../..');
    const require = createRequire(join(repository, 'package.json'));
    const providerPath = join(dirname(require.resolve('@vitest/coverage-istanbul')), 'provider.js');
    const provider = await import(pathToFileURL(providerPath).href);
    expect(provider.createNativeInstrumenter).toBeTypeOf('function');
    expect(provider.remapNativeCoverage).toBeTypeOf('function');
    const source = `class Witness {
  #used() { return 7; }
  #unused() { return 9; }
  run() { return this.#used(); }
}
function choose(flag = false) {
  if (flag) return 1;
  return 2;
}
function fail() {
  throw new Error('Expected failure');
  return 99;
}
choose();
choose(true);
new Witness().run();
try { fail(); } catch {}
`;
    const filename = join(root, 'native-witness.mjs');
    const instrumenter = provider.createNativeInstrumenter({
      produceSourceMap: true,
      autoWrap: false,
      esModules: true,
      compact: false,
      coverageVariable: '__LOREPACK_NATIVE_COVERAGE__',
      coverageGlobalScope: 'globalThis',
      coverageGlobalScopeFunc: false,
      ignoreLines: true,
    });
    const code = instrumenter.instrumentSync(source, filename);
    writeFileSync(
      filename,
      `${code}\nconsole.log(JSON.stringify(globalThis.__LOREPACK_NATIVE_COVERAGE__));\n`,
    );
    const raw = JSON.parse(execFileSync(process.execPath, [filename], { encoding: 'utf8' }));
    const providerRequire = createRequire(providerPath);
    const { createCoverageMap } = providerRequire('istanbul-lib-coverage');
    const remapped = await provider.remapNativeCoverage(createCoverageMap(raw));
    const map = remapped.fileCoverageFor(filename).toJSON();
    expect(map.s).toEqual(raw[filename].s);
    expect(map.f).toEqual(raw[filename].f);
    expect(map.b).toEqual(raw[filename].b);
    const functions = Object.entries(map.fnMap).map(([id, fn]) => ({
      line: (fn as { loc: { start: { line: number } } }).loc.start.line,
      hits: map.f[id],
    }));
    expect(functions).toEqual(
      expect.arrayContaining([
        { line: 2, hits: 1 },
        { line: 3, hits: 0 },
        { line: 6, hits: 2 },
        { line: 10, hits: 1 },
      ]),
    );
    const initializer = Object.entries(map.branchMap).find(
      ([, branch]) => (branch as { type: string }).type === 'default-arg',
    );
    if (!initializer) throw new Error('Missing initializer counter.');
    expect(map.b[initializer[0]]).toEqual([1]);
    const unreachable = Object.entries(map.statementMap).find(
      ([, statement]) => (statement as { start: { line: number } }).start.line === 12,
    );
    if (!unreachable) throw new Error('Missing unreachable statement counter.');
    expect(map.s[unreachable[0]]).toBe(0);
  });
});

it('captures actual typed transforms and reproduces every direct map and counter', async () => {
  const prepared = readdirSync(join(root, 'preparations')).map((file) =>
    JSON.parse(readFileSync(join(root, 'preparations', file), 'utf8')),
  );
  expect(prepared.map((value) => value.path).sort()).toEqual([
    'barrel.ts',
    'empty.ts',
    'private.ts',
  ]);
  const preparation = prepared.find((value) => value.path === 'private.ts');
  const original = readFileSync(join(root, 'private.ts'), 'utf8');
  expect(preparation.sha256).toBe(createHash('sha256').update(original).digest('hex'));
  expect(preparation.map.sourcesContent).toEqual([original]);
  expect(preparation.code).not.toBe(original);
  const repository = resolve(import.meta.dirname, '../../..');
  const require = createRequire(join(repository, 'package.json'));
  const providerPath = join(dirname(require.resolve('@vitest/coverage-istanbul')), 'provider.js');
  const { remapNativeCoverage } = await import(pathToFileURL(providerPath).href);
  const filename = join(root, 'private.ts');
  const entry = join(root, 'prepared-native.mjs');
  const bootstrap = join(root, 'native-bootstrap.mjs');
  const output = join(root, 'native-records');
  const snapshot = { root, included: [{ path: 'private.ts', sha256: preparation.sha256 }] };
  const nativePreparations = join(root, 'native-preparations');
  await prepareNativeCapture(snapshot, join(root, 'preparations'), nativePreparations);
  writeFileSync(
    bootstrap,
    `import {registerNativeCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)}; await registerNativeCapture(${JSON.stringify(snapshot)},${JSON.stringify(nativePreparations)},${JSON.stringify(output)});`,
  );
  writeFileSync(
    entry,
    `import {PrivateWitness} from ${JSON.stringify(pathToFileURL(filename).href)}; const instance = new PrivateWitness(); await instance.run(true); await instance.run(false);`,
  );
  execFileSync(process.execPath, ['--import', bootstrap, entry], { stdio: 'pipe' });
  const completed = readdirSync(output)
    .map((file) => JSON.parse(readFileSync(join(output, file), 'utf8')))
    .find((record) => record.state === 'completed');
  expect(completed.rejected).toEqual([]);
  expect(completed.loadedSources).toEqual([{ path: 'private.ts', sha256: preparation.sha256 }]);
  const raw = completed.maps;
  const { createCoverageMap } = createRequire(providerPath)('istanbul-lib-coverage');
  const remapped = await remapNativeCoverage(createCoverageMap(raw));
  const actual = JSON.parse(JSON.stringify(remapped.fileCoverageFor(filename).toJSON()));
  for (const field of ['statementMap', 'fnMap', 'branchMap', 's', 'f', 'b'])
    expect(actual[field]).toEqual(maps[filename]?.[field as keyof Coverage]);
});
