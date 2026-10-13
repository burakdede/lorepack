import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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
import { prepareSource, renderCoverageConfig } from '../../../scripts/coverage_configuration.mjs';
import {
  buildNativeCli,
  compiledCapturePlugin,
  prepareNativeCapture,
  reconcileNativeCapture,
  replayCounterStream,
} from '../../../scripts/coverage_instrumented.mjs';

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
  const filename = join(root, 'private.ts');
  const entry = join(root, 'prepared-native.mjs');
  const bootstrap = join(root, 'native-bootstrap.mjs');
  const output = join(root, 'native-records');
  const snapshot = {
    root,
    included: prepared.map((value) => ({ path: value.path, sha256: value.sha256 })),
  };
  const nativePreparations = join(root, 'native-preparations');
  await prepareNativeCapture(snapshot, join(root, 'preparations'), nativePreparations);
  writeFileSync(
    bootstrap,
    `import {registerNativeCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)}; await registerNativeCapture(${JSON.stringify(snapshot)},${JSON.stringify(nativePreparations)},${JSON.stringify(output)});`,
  );
  writeFileSync(
    entry,
    `import {PrivateWitness} from ${JSON.stringify(pathToFileURL(filename).href)}; import ${JSON.stringify(pathToFileURL(join(root, 'empty.ts')).href)}; import ${JSON.stringify(pathToFileURL(join(root, 'barrel.ts')).href)}; const instance = new PrivateWitness(); await instance.run(true); await instance.run(false);`,
  );
  execFileSync(process.execPath, ['--import', pathToFileURL(bootstrap).href, entry], {
    stdio: 'pipe',
  });
  const completed = readdirSync(output)
    .map((file) => JSON.parse(readFileSync(join(output, file), 'utf8')))
    .find((record) => record.state === 'completed');
  expect(completed.rejected).toEqual([]);
  expect(completed.loadedSources.map((value: { path: string }) => value.path).sort()).toEqual([
    'barrel.ts',
    'empty.ts',
    'private.ts',
  ]);
  const measured = await reconcileNativeCapture(snapshot, output, maps);
  expect(measured.status).toBe('Pass');
  expect(measured.processes).toBe(1);
  const actual = measured.maps[filename];
  expect(Object.keys(measured.maps).sort()).toEqual(Object.keys(maps).sort());
  for (const path of ['barrel.ts', 'empty.ts']) {
    expect(measured.maps[join(root, path)].s).toEqual({});
    expect(measured.maps[join(root, path)].f).toEqual({});
    expect(measured.maps[join(root, path)].b).toEqual({});
  }
  for (const field of ['statementMap', 'fnMap', 'branchMap', 's', 'f', 'b'])
    expect(actual[field]).toEqual(maps[filename]?.[field as keyof Coverage]);
});

describe('compiled native counter stream', () => {
  let bundle: string;
  let snapshot: { root: string; included: { path: string; sha256: string }[] };
  let completed: string;
  let compilation: ReturnType<typeof compiledCapturePlugin>;

  async function execute(kill: boolean, stress = false) {
    const child = fork(bundle, [kill ? 'hold' : stress ? 'stress' : 'exit'], {
      env: {},
      execArgv: ['--permission', '--allow-fs-read=*', '--max-old-space-size=64'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc', 'pipe'],
      serialization: 'advanced',
    });
    let text = '';
    let stderr = '';
    let message: unknown;
    const pipe = child.stdio[4];
    if (!pipe || !('setEncoding' in pipe)) throw new Error('Missing native counter descriptor.');
    pipe.setEncoding('utf8');
    if (stress) {
      pipe.pause();
      setTimeout(() => pipe.resume(), 100);
    }
    pipe.on('data', (chunk: string) => {
      text += chunk;
    });
    child.stderr?.on('data', (bytes: Buffer) => {
      stderr += bytes.toString('utf8');
    });
    child.on('message', (value) => {
      message = value;
      if (kill) child.kill('SIGKILL');
    });
    const result = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      },
    );
    expect(stderr).toBe('');
    expect(message).toEqual({
      outputs: [
        [2, 'yes'],
        [2, 'no'],
      ],
      writeAllowed: false,
    });
    return { text, ...result };
  }

  beforeAll(async () => {
    const repository = resolve(import.meta.dirname, '../../..');
    const prepared = readdirSync(join(root, 'preparations')).map((file) =>
      JSON.parse(readFileSync(join(root, 'preparations', file), 'utf8')),
    );
    snapshot = { root, included: prepared.map(({ path, sha256 }) => ({ path, sha256 })) };
    const directory = join(root, 'stream-preparations');
    await prepareNativeCapture(snapshot, join(root, 'preparations'), directory);
    const entry = join(root, 'stream-entry.mjs');
    execFileSync(
      process.execPath,
      [
        join(
          dirname(
            createRequire(join(repository, 'package.json')).resolve('typescript/package.json'),
          ),
          'bin/tsc',
        ),
        '--ignoreConfig',
        '--target',
        'ES2024',
        '--module',
        'NodeNext',
        '--sourceMap',
        '--skipLibCheck',
        '--outDir',
        join(root, 'dist'),
        join(root, 'private.ts'),
      ],
      { stdio: 'pipe' },
    );
    compilation = compiledCapturePlugin(snapshot, directory);
    writeFileSync(
      entry,
      `import {PrivateWitness} from './dist/private.js';
const instance = new PrivateWitness();
const outputs = [await instance.run(true), await instance.run(false)];
if (process.argv[2] === 'stress') for (let i = 0; i < 5000; i++) await instance.run(true);
const result = {outputs, writeAllowed: process.permission.has('fs.write')};
if (process.send) process.send(result);
else console.log(JSON.stringify(result));
if (process.argv[2] === 'hold') setInterval(() => {}, 1000);
else process.disconnect?.();
`,
    );
    bundle = join(root, 'stream-bundle.mjs');
    const { build } = await import('esbuild');
    await build({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node24',
      sourcemap: true,
      banner: {
        js: `import {registerCounterStream} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)}; registerCounterStream(4);`,
      },
      plugins: [compilation.plugin],
    });
    const result = await execute(false);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    completed = result.text;
  });

  async function assertActualCounters(text: string, state: string) {
    const actual = await replayCounterStream(snapshot, text);
    expect(actual.state).toBe(state);
    const require = createRequire(join(resolve(import.meta.dirname, '../../..'), 'package.json'));
    const providerPath = join(dirname(require.resolve('@vitest/coverage-istanbul')), 'provider.js');
    const { remapNativeCoverage } = await import(pathToFileURL(providerPath).href);
    const { createCoverageMap } = createRequire(providerPath)('istanbul-lib-coverage');
    const wire = JSON.parse(
      JSON.stringify((await remapNativeCoverage(createCoverageMap(actual.maps))).toJSON()),
    );
    const remapped = Object.fromEntries(
      Object.entries(wire).map(([path, map]) => [realpathSync(path), map]),
    ) as Record<string, Record<string, unknown>>;
    const filename = join(root, 'private.ts');
    const actualMap = remapped[filename];
    if (!actualMap) throw new Error('Missing remapped compiled source.');
    for (const field of ['statementMap', 'fnMap', 'branchMap', 's', 'f', 'b'])
      expect(actualMap[field]).toEqual(maps[filename]?.[field as keyof Coverage]);
    return actual;
  }

  it('preserves IPC and permission limits and exactly replays real bundled counters', async () => {
    const actual = await assertActualCounters(completed, 'completed');
    expect(actual.exitCode).toBe(0);
  });

  it('builds the CLI and every child in a separate complete measurement layout', async () => {
    const project = join(root, 'build-project');
    const files = [
      'cli/src/entry.ts',
      'cli/src/index.ts',
      'backend-local/src/sql/query-child.ts',
      'backend-local/src/archive-verify-child.ts',
      'parsers/src/parse-child.ts',
    ];
    const included = files.map((file) => {
      const path = `packages/${file}`;
      const source = `export function marker() { return 'measured'; }\n${file === 'cli/src/entry.ts' ? 'console.log(marker());\n' : ''}`;
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), source);
      return { path, sha256: createHash('sha256').update(source).digest('hex') };
    });
    const repository = resolve(import.meta.dirname, '../../..');
    const compiler = join(
      dirname(createRequire(join(repository, 'package.json')).resolve('typescript/package.json')),
      'bin/tsc',
    );
    for (const name of ['cli', 'backend-local', 'parsers']) {
      execFileSync(
        process.execPath,
        [
          compiler,
          '--ignoreConfig',
          '--target',
          'ES2024',
          '--module',
          'NodeNext',
          '--sourceMap',
          '--skipLibCheck',
          '--rootDir',
          join(project, 'packages', name, 'src'),
          '--outDir',
          join(project, 'packages', name, 'dist'),
          ...included
            .filter((entry) => entry.path.startsWith(`packages/${name}/`))
            .map((entry) => join(project, entry.path)),
        ],
        { stdio: 'pipe' },
      );
    }
    mkdirSync(join(project, 'packages/cli/studio-dist'), { recursive: true });
    mkdirSync(join(project, 'packages/cli/node_modules'));
    mkdirSync(join(project, 'packages/backend-local/migrations'));
    writeFileSync(join(project, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(project, 'packages/cli/package.json'),
      '{"type":"module","version":"0.1.0"}',
    );
    writeFileSync(
      join(project, 'packages/cli/studio-dist/index.html'),
      '<main>Fixture Studio</main>',
    );
    writeFileSync(join(project, 'packages/backend-local/migrations/001_fixture.sql'), 'SELECT 1;');
    const captured = { root: project, included };
    const preparation = join(project, 'preparations');
    mkdirSync(preparation);
    for (const entry of included) {
      const source = join(project, entry.path);
      writeFileSync(
        join(preparation, `${createHash('sha256').update(entry.path).digest('hex')}.json`),
        JSON.stringify(prepareSource(captured, source, readFileSync(source, 'utf8'), null)),
      );
    }
    const native = join(project, 'native');
    await prepareNativeCapture(captured, preparation, native);
    const before = included.map((entry) =>
      readFileSync(join(project, entry.path.replace('/src/', '/dist/').replace(/\.ts$/, '.js'))),
    );
    const output = join(project, 'measurement/dist');
    const built = await buildNativeCli(captured, native, output);
    expect(built.receipts).toHaveLength(5);
    for (const file of [
      'public-entry.js',
      'public-index.js',
      'query-child.js',
      'parse-child.js',
      'archive-verify-child.js',
    ])
      expect(readFileSync(join(output, file), 'utf8')).toContain('registerCounterStream(4)');
    expect(readFileSync(join(output, '../studio-dist/index.html'), 'utf8')).toBe(
      '<main>Fixture Studio</main>',
    );
    expect(readFileSync(join(output, 'migrations/001_fixture.sql'), 'utf8')).toBe('SELECT 1;');
    expect(
      included.map((entry) =>
        readFileSync(join(project, entry.path.replace('/src/', '/dist/').replace(/\.ts$/, '.js'))),
      ),
    ).toEqual(before);
    await expect(
      buildNativeCli(captured, native, join(project, 'packages/cli/dist')),
    ).rejects.toThrow('ordinary');
    await expect(buildNativeCli(captured, native, output)).rejects.toThrow('empty');
  });

  it('binds compilation to the real original artifact, map and source without editing them', () => {
    const filename = join(root, 'dist/private.js');
    const receipt = compilation.receipts.get(filename);
    expect(receipt).toEqual(
      expect.objectContaining({
        path: 'private.ts',
        artifact: filename,
        artifactSha256: createHash('sha256').update(readFileSync(filename)).digest('hex'),
        artifactMapSha256: createHash('sha256')
          .update(readFileSync(`${filename}.map`))
          .digest('hex'),
        sha256: snapshot.included.find((entry) => entry.path === 'private.ts')?.sha256,
      }),
    );
  });

  it('refuses compiled maps pointing to a different owned source', async () => {
    const filename = join(root, 'dist/private.js.map');
    const original = readFileSync(filename);
    const altered = JSON.parse(original.toString('utf8'));
    altered.sources = ['../empty.ts'];
    writeFileSync(filename, JSON.stringify(altered));
    try {
      const { build } = await import('esbuild');
      await expect(
        build({
          entryPoints: [join(root, 'dist/private.js')],
          outfile: join(root, 'rejected-bundle.mjs'),
          bundle: true,
          format: 'esm',
          platform: 'node',
          logLevel: 'silent',
          plugins: [compiledCapturePlugin(snapshot, join(root, 'stream-preparations')).plugin],
        }),
      ).rejects.toThrow('mapped source differs');
    } finally {
      writeFileSync(filename, original);
    }
  });

  it('refuses altered instrumented code while preserving ordinary compiler output', async () => {
    const filename = join(
      root,
      'stream-preparations',
      `${createHash('sha256').update('private.ts').digest('hex')}.json`,
    );
    const original = readFileSync(filename);
    const artifact = readFileSync(join(root, 'dist/private.js'));
    const altered = JSON.parse(original.toString('utf8'));
    altered.instrumentedCode += '\n';
    writeFileSync(filename, JSON.stringify(altered));
    try {
      const { build } = await import('esbuild');
      await expect(
        build({
          entryPoints: [join(root, 'dist/private.js')],
          outfile: join(root, 'rejected-code.mjs'),
          bundle: true,
          format: 'esm',
          platform: 'node',
          logLevel: 'silent',
          plugins: [compiledCapturePlugin(snapshot, join(root, 'stream-preparations')).plugin],
        }),
      ).rejects.toThrow('instrumented preparation differs');
      expect(readFileSync(join(root, 'dist/private.js'))).toEqual(artifact);
    } finally {
      writeFileSync(filename, original);
    }
  });

  it('captures a synchronous restricted child through a parent-opened descriptor', async () => {
    const filename = join(root, 'synchronous-counters.jsonl');
    const fd = openSync(filename, 'wx');
    try {
      const output = execFileSync(
        process.execPath,
        ['--permission', '--allow-fs-read=*', '--max-old-space-size=64', bundle, 'exit'],
        { env: {}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'ignore', fd] },
      );
      expect(JSON.parse(output)).toEqual({
        outputs: [
          [2, 'yes'],
          [2, 'no'],
        ],
        writeAllowed: false,
      });
    } finally {
      closeSync(fd);
    }
    const actual = await assertActualCounters(readFileSync(filename, 'utf8'), 'completed');
    expect(actual.exitCode).toBe(0);
  });

  it('retains executed counters across SIGKILL without inventing a completion', async () => {
    const result = await execute(true);
    expect(result.signal).toBe('SIGKILL');
    expect(result.code).toBeNull();
    const actual = await assertActualCounters(result.text, 'interrupted');
    expect(actual.exitCode).toBeNull();
  });

  it('retains every counter when the parent temporarily stops draining the pipe', async () => {
    const result = await execute(false, true);
    expect(result.code).toBe(0);
    const actual = await replayCounterStream(snapshot, result.text);
    expect(actual.state).toBe('completed');
    const map = (actual.maps as Record<string, Coverage>)[join(root, 'private.ts')];
    if (!map) throw new Error('Missing stressed native source.');
    const functions = Object.entries(map.fnMap).map(([id, fn]) => ({
      line: (fn as { loc: { start: { line: number } } }).loc.start.line,
      hits: map.f[id],
    }));
    expect(functions).toEqual(
      expect.arrayContaining([
        { line: 2, hits: 5002 },
        { line: 5, hits: 0 },
        { line: 8, hits: 5002 },
        { line: 13, hits: 5002 },
      ]),
    );
  });

  it('rejects empty, truncated, missing, repeated and reordered counter events', async () => {
    const lines = completed.trimEnd().split('\n');
    for (const text of [
      '',
      completed.slice(0, -1),
      `${lines.slice(1).join('\n')}\n`,
      `${[lines[0], ...lines].join('\n')}\n`,
      `${[lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n')}\n`,
    ])
      await expect(replayCounterStream(snapshot, text)).rejects.toThrow();
  });

  it('rejects forged counter values and completion identities', async () => {
    const records = completed
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    const counter = records.find((record) => record.state === 'counter');
    counter.value += 1;
    await expect(
      replayCounterStream(
        snapshot,
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      ),
    ).rejects.toThrow('increment');
    counter.value -= 1;
    records.at(-1).pid += 1;
    await expect(
      replayCounterStream(
        snapshot,
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      ),
    ).rejects.toThrow('identity');
  });

  it('rejects duplicate source registrations and initial execution hits', async () => {
    const records = completed
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    const source = records.find((record) => record.state === 'source');
    const duplicate = [records[0], source, structuredClone(source), ...records.slice(2)];
    duplicate.forEach((record, index) => {
      record.sequence = index + 1;
    });
    await expect(
      replayCounterStream(
        snapshot,
        `${duplicate.map((record) => JSON.stringify(record)).join('\n')}\n`,
      ),
    ).rejects.toThrow('repeated');
    const initialLine = completed.split('\n')[1];
    if (!initialLine) throw new Error('Missing native source registration.');
    const initial = JSON.parse(initialLine);
    const first = Object.keys(initial.data.f)[0];
    if (!first) throw new Error('Missing source function counter.');
    initial.data.f[first] = 1;
    await expect(
      replayCounterStream(
        snapshot,
        `${[completed.split('\n')[0], JSON.stringify(initial)].join('\n')}\n`,
      ),
    ).rejects.toThrow('starts with');
  });
});
