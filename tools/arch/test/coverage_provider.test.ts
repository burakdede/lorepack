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
  createCampaignRegistry,
  prepareNativeCapture,
  reconcileForkCapture,
  reconcileNativeCapture,
  replayCounterStream,
} from '../../../scripts/coverage_instrumented.mjs';

type Coverage = {
  path: string;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
  statementMap: Record<
    string,
    { start: { line: number; column: number }; end: { line: number; column: number } }
  >;
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
  close() {
    return this.#used(2);
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

it('captures synchronous owned cleanup after later exit listeners', async () => {
  const repository = resolve(import.meta.dirname, '../../..');
  const prepared = readdirSync(join(root, 'preparations')).map((file) =>
    JSON.parse(readFileSync(join(root, 'preparations', file), 'utf8')),
  );
  const snapshot = {
    root,
    included: prepared.map((value) => ({ path: value.path, sha256: value.sha256 })),
  };
  const preparations = join(root, 'late-native-preparations');
  await prepareNativeCapture(snapshot, join(root, 'preparations'), preparations);
  const filename = join(root, 'private.ts');
  for (const manual of [false, true]) {
    const output = join(root, `late-native-${manual}`);
    const bootstrap = join(root, `late-native-bootstrap-${manual}.mjs`);
    const entry = join(root, `late-native-entry-${manual}.mjs`);
    writeFileSync(
      bootstrap,
      `import {registerNativeCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)}; await registerNativeCapture(${JSON.stringify(snapshot)},${JSON.stringify(preparations)},${JSON.stringify(output)});`,
    );
    writeFileSync(
      entry,
      `import {PrivateWitness} from ${JSON.stringify(pathToFileURL(filename).href)};const instance=new PrivateWitness();await instance.run(true);await instance.run(false);process.on('exit',()=>process.stdout.write(String(instance.close())));${manual ? "process.emit('exit',0);" : ''}`,
    );
    expect(
      execFileSync(process.execPath, ['--import', pathToFileURL(bootstrap).href, entry], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toBe(manual ? '33' : '3');
    const measured = await reconcileNativeCapture(snapshot, output, maps);
    expect(measured.status).toBe('Pass');
    const actual = measured.maps[filename];
    const close = Object.entries(actual.fnMap).find(
      ([, fn]) => (fn as { loc: { start: { line: number } } }).loc.start.line === 16,
    );
    if (!close) throw new Error('Missing actual cleanup function.');
    expect(actual.f[close[0]]).toBe(manual ? 2 : 1);
  }
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

it('rejects a file snapshot superseded by real shutdown microtasks', async () => {
  const repository = resolve(import.meta.dirname, '../../..');
  const prepared = readdirSync(join(root, 'preparations')).map((file) =>
    JSON.parse(readFileSync(join(root, 'preparations', file), 'utf8')),
  );
  const snapshot = {
    root,
    included: prepared.map((value) => ({ path: value.path, sha256: value.sha256 })),
  };
  const preparations = join(root, 'microtask-native-preparations');
  await prepareNativeCapture(snapshot, join(root, 'preparations'), preparations);
  const output = join(root, 'microtask-native-records');
  const bootstrap = join(root, 'microtask-native-bootstrap.mjs');
  const entry = join(root, 'microtask-native-entry.mjs');
  writeFileSync(
    bootstrap,
    `import {registerNativeCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};await registerNativeCapture(${JSON.stringify(snapshot)},${JSON.stringify(preparations)},${JSON.stringify(output)});`,
  );
  writeFileSync(
    entry,
    `import {PrivateWitness} from ${JSON.stringify(pathToFileURL(join(root, 'private.ts')).href)};const instance=new PrivateWitness();process.once('exit',()=>Promise.resolve().then(()=>process.stdout.write(String(instance.close()))));`,
  );
  expect(
    execFileSync(process.execPath, ['--import', pathToFileURL(bootstrap).href, entry], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  ).toBe('3');
  const measured = await reconcileNativeCapture(snapshot, output, maps);
  expect(measured.status).toBe('Fail');
  expect(measured.maps).toBeNull();
  expect(measured.issues).toEqual([
    expect.objectContaining({ kind: 'rejected-execution', path: 'private.ts' }),
  ]);
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
const result = {outputs, writeAllowed: process.permission === undefined || process.permission.has('fs.write')};
if (process.argv[3] === 'inspect') Object.assign(result, {execArgv: process.execArgv, inheritedMarker: process.env.LORE_CAPTURE_PARENT_ONLY ?? null});
if (process.send) process.send(result);
else console.log(JSON.stringify(result));
if (process.argv[2] === 'fail') {process.stderr.write('fixture failure\\n');process.exitCode=7;}
if (process.argv[2] === 'exit-window') {const emit=process.emit;process.emit=function(event,...args){const result=emit.call(this,event,...args);if(event==='exit')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);return result;};}
if (['late-exit','manual-exit'].includes(process.argv[2])) {process.on('exit',()=>process.stdout.write(String(instance.close())));if(process.argv[2]==='manual-exit')process.emit('exit',0);}
if (process.argv[2] === 'exit-microtask') process.once('exit',()=>Promise.resolve().then(()=>process.stdout.write(String(instance.close()))));
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

  async function remapCounters(text: string) {
    const actual = await replayCounterStream(snapshot, text);
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
    return { actual, actualMap };
  }

  async function assertActualCounters(text: string, state: string) {
    const { actual, actualMap } = await remapCounters(text);
    expect(actual.state).toBe(state);
    const filename = join(root, 'private.ts');
    for (const field of ['statementMap', 'fnMap', 'branchMap', 's', 'f', 'b'])
      expect(actualMap[field]).toEqual(maps[filename]?.[field as keyof Coverage]);
    return actual;
  }

  it('preserves IPC and permission limits and exactly replays real bundled counters', async () => {
    const actual = await assertActualCounters(completed, 'completed');
    expect(actual.exitCode).toBe(0);
  });

  it('records compiled cleanup before completion and ignores manual exit events', async () => {
    for (const [mode, calls] of [
      ['late-exit', 1],
      ['manual-exit', 2],
    ] as const) {
      const filename = join(root, `${mode}.counters.jsonl`);
      const fd = openSync(filename, 'wx');
      let stdout: string;
      try {
        stdout = execFileSync(
          process.execPath,
          ['--permission', '--allow-fs-read=*', '--max-old-space-size=64', bundle, mode],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'ignore', fd] },
        );
      } finally {
        closeSync(fd);
      }
      expect(stdout.trimEnd().split('\n').at(-1)).toBe('3'.repeat(calls));
      const text = readFileSync(filename, 'utf8');
      const records = text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.filter((record) => record.state === 'completed')).toHaveLength(1);
      expect(records.at(-1).state).toBe('completed');
      const { actual, actualMap } = await remapCounters(text);
      expect(actual.state).toBe('completed');
      const map = actualMap as unknown as Coverage;
      const close = Object.entries(map.fnMap).find(([, fn]) => fn.loc.start.line === 16);
      const used = Object.entries(map.fnMap).find(([, fn]) => fn.loc.start.line === 2);
      if (!close || !used) throw new Error('Missing actual compiled cleanup functions.');
      expect(map.f[close[0]]).toBe(calls);
      expect(map.f[used[0]]).toBe(2 + calls);
    }
  });

  it('builds the CLI and every child in a separate complete measurement layout', async () => {
    const project = join(root, 'build-project');
    const files = [
      'core/src/shared.ts',
      'cli/src/entry.ts',
      'cli/src/index.ts',
      'backend-local/src/sql/query-child.ts',
      'backend-local/src/archive-verify-child.ts',
      'parsers/src/parse-child.ts',
    ];
    const included = files.map((file) => {
      const path = `packages/${file}`;
      const shared = file.includes('/sql/')
        ? '../../../core/dist/shared.js'
        : '../../core/dist/shared.js';
      const source = `${file === 'core/src/shared.ts' ? "export function marker() { return 'measured'; }" : `import {marker} from '${shared}';export {marker};`}\n${
        file === 'cli/src/entry.ts'
          ? `import {fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
for(const filename of ['parse-child.js','query-child.js']) {
 const child=fork(new URL(filename,import.meta.url),[],{env:{},execArgv:['--permission','--allow-fs-read=*','--max-old-space-size=64'],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});
 const message=await new Promise(resolve=>child.once('message',resolve));
 console.log(JSON.stringify(message));child.kill('SIGKILL');child.unref();
}
const {stdout}=await promisify(execFile)(process.execPath,['--max-old-space-size=128',fileURLToPath(new URL('archive-verify-child.js',import.meta.url))],{env:{}});
console.log(stdout.trim());process.exit(7);console.log('must not run');\n`
          : file.endsWith('archive-verify-child.ts')
            ? 'console.log(JSON.stringify({marker:marker(),execArgv:process.execArgv}));\n'
            : file.endsWith('child.ts')
              ? "process.send?.({marker:marker(),writeAllowed:process.permission?.has('fs.write')});setInterval(()=>{},1000);\n"
              : ''
      }`;
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), source);
      return { path, sha256: createHash('sha256').update(source).digest('hex') };
    });
    const repository = resolve(import.meta.dirname, '../../..');
    const compiler = join(
      dirname(createRequire(join(repository, 'package.json')).resolve('typescript/package.json')),
      'bin/tsc',
    );
    for (const name of ['core', 'cli', 'backend-local', 'parsers']) {
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
          '--declaration',
          '--skipLibCheck',
          '--types',
          'node',
          '--rootDir',
          join(project, 'packages', name, 'src'),
          '--outDir',
          join(project, 'packages', name, 'dist'),
          ...included
            .filter((entry) => entry.path.startsWith(`packages/${name}/`))
            .map((entry) => join(project, entry.path)),
        ],
        { stdio: 'inherit' },
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
    const { bundleCli } = await import('../../../scripts/bundle-cli.mjs');
    await bundleCli({ root: project });
    const output = join(project, 'measurement/dist');
    const built = await buildNativeCli(captured, native, output);
    expect(built.receipts).toHaveLength(6);
    for (const file of [
      'public-entry.js',
      'public-index.js',
      'query-child.js',
      'parse-child.js',
      'archive-verify-child.js',
    ])
      expect(readFileSync(join(output, file), 'utf8')).toContain(
        "import './capture-bootstrap.mjs'",
      );
    expect(readFileSync(join(output, '../studio-dist/index.html'), 'utf8')).toBe(
      '<main>Fixture Studio</main>',
    );
    expect(readFileSync(join(output, 'migrations/001_fixture.sql'), 'utf8')).toBe('SELECT 1;');
    const launch = built.launch;
    expect(JSON.parse(readFileSync(join(output, 'launch.receipts.json'), 'utf8'))).toEqual(launch);
    expect(launch.entrySha256).toBe(
      createHash('sha256').update(readFileSync(launch.entry)).digest('hex'),
    );
    const counterFile = join(project, 'cli-counters.jsonl');
    const fd = openSync(counterFile, 'wx');
    let result: import('node:child_process').SpawnSyncReturns<string>;
    try {
      const { spawnSync } = await import('node:child_process');
      result = spawnSync(process.execPath, [launch.entry], {
        env: {},
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe', 'ignore', fd],
      });
    } finally {
      closeSync(fd);
    }
    expect(result.stderr).toBe('');
    expect(result.status).toBe(7);
    expect(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { marker: 'measured', writeAllowed: false },
      { marker: 'measured', writeAllowed: false },
      { marker: 'measured', execArgv: ['--max-old-space-size=128'] },
    ]);
    const children = await reconcileForkCapture(captured, launch.captureDirectory, [
      ...launch.forkEntries,
      ...launch.commandEntries,
    ]);
    expect(children.status).toBe('Pass');
    expect(children.processes).toBe(3);
    expect(
      children.executions.filter((execution) => execution.state === 'interrupted'),
    ).toHaveLength(2);
    expect(children.executions.filter((execution) => execution.state === 'completed')).toHaveLength(
      1,
    );
    expect(Object.keys(children.maps)).toHaveLength(4);
    const parent = await replayCounterStream(captured, readFileSync(counterFile, 'utf8'));
    expect(parent.state).toBe('completed');
    expect(parent.exitCode).toBe(7);
    expect(Object.keys(parent.maps)).toHaveLength(2);
    const registry = createCampaignRegistry(captured, launch);
    expect(registry.forkEntries).toHaveLength(6);
    expect(registry.commandEntries).toHaveLength(6);
    const worker = join(project, 'captured-worker.mjs');
    writeFileSync(
      worker,
      `import {fork,execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {registerCampaignCapture,registerCommandCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
const capture=registerCampaignCapture(${JSON.stringify(captured)},${JSON.stringify(launch)});
const messages=[];
for(const original of ${JSON.stringify(['packages/parsers/dist/parse-child.js', 'packages/backend-local/dist/sql/query-child.js'].map((path) => join(project, path)))}){
 const child=fork(original,[],{env:{},execArgv:['--permission','--allow-fs-read=*','--max-old-space-size=64'],stdio:['ignore','ignore','ignore','ipc']});
 messages.push(await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);}));child.kill('SIGKILL');
}
const archive=await promisify(execFile)(process.execPath,['--max-old-space-size=128',${JSON.stringify(join(project, 'packages/backend-local/dist/archive-verify-child.js'))}],{env:{}});
const cli=spawnSync(process.execPath,[${JSON.stringify(join(project, 'packages/cli/dist/public-entry.js'))}],{env:{},encoding:'utf8'});
await capture.settled();capture.restore();
const before=fork,existing=registerCommandCapture(capture.registry.commandEntries,${JSON.stringify(launch.captureDirectory)});
let registrationRejected=false;
try{registerCampaignCapture(${JSON.stringify(captured)},${JSON.stringify(launch)});}catch(error){registrationRejected=error.message.includes('already registered');}
const forkRestored=fork===before;existing.restore();
const retry=registerCampaignCapture(${JSON.stringify(captured)},${JSON.stringify(launch)});await retry.settled();retry.restore();
console.log(JSON.stringify({messages,archive,registrationRejected,forkRestored,cli:{status:cli.status,stdout:cli.stdout,stderr:cli.stderr}}));`,
    );
    const workerResult = JSON.parse(execFileSync(process.execPath, [worker], { encoding: 'utf8' }));
    expect(workerResult.messages).toEqual([
      { marker: 'measured', writeAllowed: false },
      { marker: 'measured', writeAllowed: false },
    ]);
    expect(JSON.parse(workerResult.archive.stdout)).toEqual({
      marker: 'measured',
      execArgv: ['--max-old-space-size=128'],
    });
    expect(workerResult.archive.stderr).toBe('');
    expect(workerResult.cli.status).toBe(7);
    expect(workerResult.cli.stderr).toBe('');
    expect(workerResult.cli.stdout).toBe(result.stdout);
    expect(workerResult.registrationRejected).toBe(true);
    expect(workerResult.forkRestored).toBe(true);
    const workerCapture = await reconcileForkCapture(captured, launch.captureDirectory, [
      ...registry.forkEntries,
      ...registry.commandEntries,
    ]);
    expect(workerCapture.status).toBe('Pass');
    expect(workerCapture.processes).toBe(10);
    const sharedChunk = readdirSync(output).find((filename) =>
      /^chunk-[A-Z0-9]{8}\.js$/.test(filename),
    );
    expect(sharedChunk).toBeDefined();
    for (const filename of [
      'query-child.js',
      'archive-verify-child.js',
      'public-entry.js',
      'measurement-public-entry.js',
      'measurement-query-child.js',
      'capture-bootstrap.mjs',
      sharedChunk as string,
    ]) {
      const changed = join(output, filename);
      const retained = readFileSync(changed);
      try {
        writeFileSync(changed, Buffer.concat([retained, Buffer.from('\n// stale artifact')]));
        const { spawnSync } = await import('node:child_process');
        const stale = spawnSync(process.execPath, [launch.entry], { encoding: 'utf8' });
        expect(stale.status).toBe(1);
        expect(stale.stdout).toBe('');
        expect(stale.stderr).toContain('Native CLI artifact differs from its receipt.');
        expect(() => createCampaignRegistry(captured, launch)).toThrow(
          'Native CLI artifact differs from its receipt.',
        );
      } finally {
        writeFileSync(changed, retained);
      }
    }
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

  it('captures normal host forks and drains unrefed children without changing their options', async () => {
    const repository = resolve(import.meta.dirname, '../../..');
    const original = join(root, 'ordinary-fork-entry.mjs');
    writeFileSync(original, 'throw new Error("The registered original must be redirected");');
    const entries = [
      {
        original,
        target: bundle,
        originalSha256: createHash('sha256').update(readFileSync(original)).digest('hex'),
        targetSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      },
    ];
    const directory = join(root, 'host-fork-records');
    const parent = join(root, 'host-fork-parent.mjs');
    const foreign = join(root, 'foreign-fork-entry.mjs');
    writeFileSync(
      foreign,
      "process.send({kind:'delegated',args:process.argv.slice(2),execArgv:process.execArgv});process.disconnect();",
    );
    writeFileSync(
      parent,
      `
import {fork} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {registerForkCapture,replayCounterStream} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
process.env.LORE_CAPTURE_PARENT_ONLY = 'fixture-only';
const capture = registerForkCapture(${JSON.stringify(entries)},${JSON.stringify(directory)});
let duplicateRejected = false;
try { registerForkCapture(${JSON.stringify(entries)},${JSON.stringify(directory)}); } catch(error) { duplicateRejected = error.message.includes('already registered'); }
const options = {env:{},execArgv:['--permission','--allow-fs-read=*','--max-old-space-size=64'],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']};
const before = JSON.stringify(options);
const child = fork(${JSON.stringify(original)},['hold','inspect'],options);
const message = await new Promise((resolve,reject) => { child.once('message',resolve); child.once('error',reject); });
child.kill('SIGKILL');child.unref();
await capture.settled();
const second = fork(${JSON.stringify(original)},undefined,options);
const secondClosed = new Promise((resolve,reject)=>{second.once('close',resolve);second.once('error',reject);});
const secondMessage = await new Promise(resolve=>second.once('message',resolve));
await secondClosed;await capture.settled();
const foreign = fork(${JSON.stringify(foreign)},['external'],{env:{},execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
const foreignClosed = new Promise((resolve,reject)=>{foreign.once('close',resolve);foreign.once('error',reject);});
const delegated = await new Promise(resolve=>foreign.once('message',resolve));
await foreignClosed;capture.restore();
const launch = capture.launches[0];
const closed = JSON.parse(readFileSync(join(${JSON.stringify(directory)},launch.id+'.close.json'),'utf8'));
const counters = await replayCounterStream(${JSON.stringify(snapshot)},readFileSync(join(${JSON.stringify(directory)},launch.id+'.counters.jsonl'),'utf8'));
console.log(JSON.stringify({message,optionsUnchanged:before===JSON.stringify(options),closed,counters,delegated,launches:capture.launches.length,secondMessage,duplicateRejected}));
`,
    );
    const result = JSON.parse(
      execFileSync(process.execPath, [parent], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(result.optionsUnchanged).toBe(true);
    expect(result.launches).toBe(2);
    expect(result.duplicateRejected).toBe(true);
    expect(result.secondMessage).toEqual({
      outputs: [
        [2, 'yes'],
        [2, 'no'],
      ],
      writeAllowed: false,
    });
    expect(result.delegated).toEqual({ kind: 'delegated', args: ['external'], execArgv: [] });
    expect(result.message).toEqual({
      outputs: [
        [2, 'yes'],
        [2, 'no'],
      ],
      writeAllowed: false,
      execArgv: ['--permission', '--allow-fs-read=*', '--max-old-space-size=64'],
      inheritedMarker: null,
    });
    expect(result.closed.environment).toBe('empty');
    expect(result.closed.signal).toBe('SIGKILL');
    expect(result.closed.kills).toEqual([{ signal: 'SIGKILL', result: true }]);
    expect(result.counters.pid).toBe(result.closed.pid);
    expect(result.counters.state).toBe('interrupted');
    expect(Object.keys(result.counters.maps)).toEqual([join(root, 'private.ts')]);
    const registry = entries.map((entry) => ({ ...entry, interruptionSignals: ['SIGKILL'] }));
    const reconciled = await reconcileForkCapture(snapshot, directory, registry, maps);
    expect(reconciled.status).toBe('Pass');
    expect(reconciled.processes).toBe(2);
    expect(
      reconciled.executions.map((execution: { state: string }) => execution.state).sort(),
    ).toEqual(['completed', 'interrupted']);
    const filename = join(root, 'private.ts');
    const actual = reconciled.maps[filename];
    if (!actual || !maps[filename]) throw new Error('Missing reconciled fork map.');
    for (const field of ['statementMap', 'fnMap', 'branchMap'])
      expect(actual[field]).toEqual(maps[filename][field as keyof Coverage]);
    for (const field of ['s', 'f'])
      for (const [key, hits] of Object.entries(maps[filename][field as 's' | 'f']))
        expect(actual[field][key]).toBe(hits * 2);
    for (const [key, arms] of Object.entries(maps[filename].b))
      expect(actual.b[key]).toEqual(arms.map((hits) => hits * 2));

    const retained = Object.fromEntries(
      readdirSync(directory).map((file) => [file, readFileSync(join(directory, file), 'utf8')]),
    );
    const launches = Object.entries(retained)
      .filter(([file]) => file.endsWith('.launch.json'))
      .map(([, text]) => JSON.parse(text));
    const interrupted = launches.find((launch) => launch.pid === result.closed.pid);
    const normal = launches.find((launch) => launch.pid !== result.closed.pid);
    if (!interrupted || !normal) throw new Error('Missing normal or interrupted fork receipt.');
    const closed = `${interrupted.id}.close.json`;
    const stream = `${interrupted.id}.counters.jsonl`;
    const originalClose = retained[closed];
    const originalStream = retained[stream];
    const normalClose = retained[`${normal.id}.close.json`];
    if (!originalClose || !originalStream || !normalClose)
      throw new Error('Missing normal or interrupted fork evidence.');
    const invalid = [
      { file: closed, value: null },
      { file: stream, value: null },
      { file: closed, value: JSON.stringify({ ...JSON.parse(originalClose), pid: normal.pid }) },
      {
        file: `${normal.id}.close.json`,
        value: JSON.stringify({ ...JSON.parse(normalClose), code: 1 }),
      },
      {
        file: `${normal.id}.close.json`,
        value: JSON.stringify({ ...JSON.parse(normalClose), signal: 'SIGKILL' }),
      },
      { file: closed, value: JSON.stringify({ ...JSON.parse(originalClose), kills: [] }) },
      {
        file: closed,
        value: JSON.stringify({
          ...JSON.parse(originalClose),
          kills: [{ signal: 'SIGKILL', result: false }],
        }),
      },
      { file: closed, value: JSON.stringify({ ...JSON.parse(originalClose), signal: 'SIGTERM' }) },
      { file: stream, value: originalStream.slice(0, -1) },
      { file: stream, value: '' },
      { file: 'orphan.counters.jsonl', value: originalStream },
      {
        file: `${normal.id}.counters.jsonl`,
        value: `${originalStream
          .trimEnd()
          .split('\n')
          .map((line, index) => {
            const record = JSON.parse(line);
            if (index === 0) record.pid = normal.pid;
            return JSON.stringify(record);
          })
          .join('\n')}\n`,
      },
    ];
    for (const control of invalid) {
      try {
        if (control.value === null) rmSync(join(directory, control.file));
        else writeFileSync(join(directory, control.file), control.value);
        await expect(reconcileForkCapture(snapshot, directory, registry, maps)).rejects.toThrow();
      } finally {
        for (const file of readdirSync(directory)) rmSync(join(directory, file));
        for (const [file, text] of Object.entries(retained))
          writeFileSync(join(directory, file), text);
      }
    }
    await expect(
      reconcileForkCapture(
        snapshot,
        directory,
        registry.map((entry) => ({ ...entry, targetSha256: '0'.repeat(64) })),
        maps,
      ),
    ).rejects.toThrow('Invalid fork reconciliation entrypoint');
    await expect(reconcileForkCapture(snapshot, directory, [], maps)).rejects.toThrow(
      'Unregistered fork launch',
    );
    await expect(
      reconcileForkCapture(
        snapshot,
        directory,
        entries.map((entry) => ({ ...entry, interruptionSignals: [] })),
        maps,
      ),
    ).rejects.toThrow('Unqualified fork interruption');
    const different = structuredClone(maps);
    const differentMap = different[filename];
    if (!differentMap) throw new Error('Missing direct layout fixture.');
    differentMap.fnMap = {};
    await expect(reconcileForkCapture(snapshot, directory, registry, different)).rejects.toThrow(
      'Fork coverage layout differs',
    );
  });

  it('captures spawn and callback or promised execFile without replacing Node output handling', async () => {
    const repository = resolve(import.meta.dirname, '../../..');
    const original = join(root, 'ordinary-command-entry.mjs');
    writeFileSync(original, 'throw new Error("The registered original must be redirected");');
    const entry = {
      original,
      target: bundle,
      originalSha256: createHash('sha256').update(readFileSync(original)).digest('hex'),
      targetSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      interruptionSignals: ['SIGTERM'],
    };
    const alias = join(root, 'ordinary-command-alias.mjs');
    writeFileSync(alias, 'throw new Error("The registered alias must be redirected");');
    const entries = [
      entry,
      {
        ...entry,
        original: alias,
        originalSha256: createHash('sha256').update(readFileSync(alias)).digest('hex'),
      },
      { ...entry, original: bundle, originalSha256: entry.targetSha256 },
    ];
    const directory = join(root, 'command-records');
    const parent = join(root, 'command-parent.mjs');
    writeFileSync(
      parent,
      `import {spawn,execFile} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {registerCommandCapture,reconcileForkCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
const executeBefore = promisify(execFile);
const capture = registerCommandCapture(${JSON.stringify(entries)},${JSON.stringify(directory)});
const executeAfter = promisify(execFile);
let duplicateRejected = false;
try {registerCommandCapture(${JSON.stringify(entries)},${JSON.stringify(directory)});} catch(error) {duplicateRejected=error.message.includes('already registered');}
const options = {env:{},cwd:${JSON.stringify(root)},encoding:'utf8',timeout:10000,maxBuffer:10000};
const before = JSON.stringify(options);
const outcomes = [];
const child = spawn(process.execPath,[${JSON.stringify(original)},'exit','inspect'],{env:{},cwd:${JSON.stringify(root)},stdio:['ignore','pipe','pipe'],argv0:'captured-node'});
let stdout='',stderr='';
child.stdout.setEncoding('utf8').on('data',chunk=>stdout+=chunk);
child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
await new Promise((resolve,reject)=>{child.once('close',code=>{outcomes.push({code,stdout,stderr});resolve();});child.once('error',reject);});
outcomes.push(await new Promise((resolve)=>execFile(process.execPath,[${JSON.stringify(alias)},'exit','inspect'],options,(error,stdout,stderr)=>resolve({code:error?.code??0,stdout,stderr}))));
outcomes.push({code:0,...await executeBefore(process.execPath,[${JSON.stringify(original)},'exit','inspect'],options)});
outcomes.push({code:0,...await executeAfter(process.execPath,[${JSON.stringify(bundle)},'exit','inspect'],options)});
let failure;
try {await executeBefore(process.execPath,[${JSON.stringify(original)},'fail'],options);} catch(error) {failure={code:error.code,stdout:error.stdout,stderr:error.stderr,killed:error.killed};}
let timeout;
try {await executeAfter(process.execPath,[${JSON.stringify(original)},'hold'],{...options,timeout:1000});} catch(error) {timeout={signal:error.signal,killed:error.killed,stdout:error.stdout};}
let maxBuffer;
try {await executeBefore(process.execPath,[${JSON.stringify(original)},'exit'],{...options,maxBuffer:8});} catch(error) {maxBuffer={code:error.code,stdout:error.stdout,killed:error.killed};}
let extraDescriptorsRejected=false;
try {spawn(process.execPath,[${JSON.stringify(original)}],{stdio:['ignore','ignore','ignore','ignore']});} catch(error) {extraDescriptorsRejected=error.message.includes('three-descriptor');}
const foreign=await executeBefore(process.execPath,['--input-type=module','-e','console.log(JSON.stringify(process.argv.slice(1)))',${JSON.stringify(original)}],{env:{}});
const closing=spawn(process.execPath,[${JSON.stringify(original)},'exit-window'],{env:{},stdio:['ignore','ignore','ignore']});
const closingLaunch=capture.launches.at(-1);
let exitRecorded=false;
for(let attempt=0;attempt<200;attempt++) {
 const stream=readFileSync(join(${JSON.stringify(directory)},closingLaunch.id+'.counters.jsonl'),'utf8');
 const last=stream.lastIndexOf('\\n');
 const lines=last<0?[]:stream.slice(0,last).split('\\n').filter(Boolean);
 exitRecorded=lines.some(line=>JSON.parse(line).state==='completed');
 if(exitRecorded) break;
 await delay(5);
}
if(!exitRecorded) throw new Error('The deterministic exit window was not reached');
const closingKilled=closing.kill('SIGTERM');
await capture.settled();
const originalTarget=readFileSync(${JSON.stringify(bundle)});
let changedEntryRejected=false;
try {
 writeFileSync(${JSON.stringify(bundle)},Buffer.concat([originalTarget,Buffer.from('\\n// changed target')]));
 try {spawn(process.execPath,[${JSON.stringify(original)}]);} catch(error) {changedEntryRejected=error.message.includes('changed before launch');}
} finally {writeFileSync(${JSON.stringify(bundle)},originalTarget);}
capture.restore();
const reconciled=await reconcileForkCapture(${JSON.stringify(snapshot)},${JSON.stringify(directory)},${JSON.stringify(entries)});
console.log(JSON.stringify({outcomes,failure,timeout,maxBuffer,closingKilled,extraDescriptorsRejected,changedEntryRejected,foreign,optionsUnchanged:before===JSON.stringify(options),duplicateRejected,launches:capture.launches,reconciled}));
`,
    );
    const result = JSON.parse(
      execFileSync(process.execPath, [parent], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(result.optionsUnchanged).toBe(true);
    expect(result.duplicateRejected).toBe(true);
    expect(result.outcomes).toHaveLength(4);
    for (const outcome of result.outcomes) {
      expect(outcome.code).toBe(0);
      expect(outcome.stderr).toBe('');
      expect(JSON.parse(outcome.stdout)).toEqual({
        outputs: [
          [2, 'yes'],
          [2, 'no'],
        ],
        writeAllowed: true,
        execArgv: [],
        inheritedMarker: null,
      });
    }
    expect(result.failure.code).toBe(7);
    expect(result.failure.stderr).toBe('fixture failure\n');
    expect(result.failure.killed).toBe(false);
    expect(JSON.parse(result.failure.stdout).outputs).toEqual([
      [2, 'yes'],
      [2, 'no'],
    ]);
    expect(result.timeout.signal).toBe('SIGTERM');
    expect(result.timeout.killed).toBe(true);
    expect(JSON.parse(result.timeout.stdout).writeAllowed).toBe(true);
    expect(result.maxBuffer.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    expect(result.maxBuffer.stdout).toBe('{"output');
    expect(result.maxBuffer).not.toHaveProperty('killed');
    expect(result.extraDescriptorsRejected).toBe(true);
    expect(result.changedEntryRejected).toBe(true);
    expect(JSON.parse(result.foreign.stdout)).toEqual([original]);
    expect(result.launches).toHaveLength(8);
    expect(
      result.launches.slice(0, 4).map((launch: { original: string }) => launch.original),
    ).toEqual([original, alias, original, bundle]);
    expect(
      result.launches.every(
        (launch: { environment: string }) => launch.environment === 'normalized',
      ),
    ).toBe(true);
    expect(result.reconciled.processes).toBe(8);
    const timedOut = result.reconciled.executions.find(
      (execution: { launchId: string }) => execution.launchId === result.launches[5].id,
    );
    expect(timedOut).toMatchObject({ state: 'interrupted', signal: 'SIGTERM', exitCode: null });
    expect(result.closingKilled).toBe(true);
    const closing = result.reconciled.executions.find(
      (execution: { launchId: string }) => execution.launchId === result.launches[7].id,
    );
    expect(closing).toMatchObject({
      state: 'interrupted',
      exitCode: null,
      signal: 'SIGTERM',
      counterState: 'completed',
      counterExitCode: 0,
    });
    const filename = join(root, 'private.ts');
    const actual = result.reconciled.maps[filename];
    if (!maps[filename] || !actual) throw new Error('Missing reconciled command map.');
    for (const field of ['statementMap', 'fnMap', 'branchMap'])
      expect(actual[field]).toEqual(maps[filename][field as keyof Coverage]);
    for (const field of ['s', 'f'])
      for (const [key, hits] of Object.entries(maps[filename][field as 's' | 'f']))
        expect(actual[field][key]).toBe(hits * 8);
    for (const [key, arms] of Object.entries(maps[filename].b))
      expect(actual.b[key]).toEqual(arms.map((hits) => hits * 8));
  });

  it('captures registered heap-prefixed commands without changing Node arguments', () => {
    const repository = resolve(import.meta.dirname, '../../..');
    const original = join(root, 'ordinary-prefixed-entry.mjs');
    writeFileSync(original, 'throw new Error("The registered entry must be redirected");');
    const entry = {
      original,
      target: bundle,
      originalSha256: createHash('sha256').update(readFileSync(original)).digest('hex'),
      targetSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      interruptionSignals: ['SIGTERM'],
      nodeArguments: ['--max-old-space-size=128'],
    };
    const directory = join(root, 'prefixed-command-records');
    const parent = join(root, 'prefixed-command-parent.mjs');
    writeFileSync(
      parent,
      `import {execFile,spawnSync,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {registerCommandCapture,registerSyncCommandCapture,reconcileForkCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
const entry=${JSON.stringify(entry)},directory=${JSON.stringify(directory)};
const execute=promisify(execFile),options={env:{},encoding:'utf8',stdio:'pipe'};
const args=[...entry.nodeArguments,entry.original,'exit','inspect'];
const originalArgs=JSON.stringify(args),originalOptions=JSON.stringify(options);
const asyncCapture=registerCommandCapture([entry],directory);
const asynchronous=await execute(process.execPath,args,options);
await asyncCapture.settled();asyncCapture.restore();
const syncCapture=registerSyncCommandCapture([entry],directory);
const synchronous=spawnSync(process.execPath,args,options);
const executed=execFileSync(process.execPath,args,options);
const delegated=spawnSync(process.execPath,['--max-old-space-size=64',entry.original],options);
syncCapture.restore();
const invalid=[];
for(const register of [registerCommandCapture,registerSyncCommandCapture]){
 try{register([{...entry,nodeArguments:['-e']}],directory);}catch(error){invalid.push(error.message);}
}
const reconciled=await reconcileForkCapture(${JSON.stringify(snapshot)},directory,[entry],${JSON.stringify(maps)});
console.log(JSON.stringify({asynchronous,synchronous:{status:synchronous.status,stdout:synchronous.stdout,stderr:synchronous.stderr},executed,delegated:{status:delegated.status,stderr:delegated.stderr},invalid,unchanged:JSON.stringify(args)===originalArgs&&JSON.stringify(options)===originalOptions,reconciled}));`,
    );
    const result = JSON.parse(execFileSync(process.execPath, [parent], { encoding: 'utf8' }));
    expect(result.unchanged).toBe(true);
    expect(result.asynchronous.stderr).toBe('');
    expect(result.synchronous.status).toBe(0);
    expect(result.synchronous.stderr).toBe('');
    expect(result.executed).toBe(result.asynchronous.stdout);
    expect(result.synchronous.stdout).toBe(result.executed);
    expect(JSON.parse(result.executed)).toMatchObject({
      execArgv: ['--max-old-space-size=128'],
      inheritedMarker: null,
    });
    expect(result.delegated.status).toBe(1);
    expect(result.delegated.stderr).toContain('The registered entry must be redirected');
    expect(result.invalid).toEqual([
      'Invalid command capture Node argument prefix.',
      'Invalid command capture Node argument prefix.',
    ]);
    expect(result.reconciled.status).toBe('Pass');
    expect(result.reconciled.processes).toBe(3);
    const filename = join(root, 'private.ts');
    const actual = result.reconciled.maps[filename];
    if (!maps[filename] || !actual) throw new Error('Missing reconciled prefixed command map.');
    for (const field of ['statementMap', 'fnMap', 'branchMap'])
      expect(actual[field]).toEqual(maps[filename][field as keyof Coverage]);
    for (const field of ['s', 'f'])
      for (const [key, hits] of Object.entries(maps[filename][field as 's' | 'f']))
        expect(actual[field][key]).toBe(hits * 3);
    for (const [key, arms] of Object.entries(maps[filename].b))
      expect(actual.b[key]).toEqual(arms.map((hits) => hits * 3));
  });

  it('captures synchronous result, errors and native timeout evidence', async () => {
    const repository = resolve(import.meta.dirname, '../../..');
    const original = join(root, 'ordinary-sync-entry.mjs');
    writeFileSync(original, 'throw new Error("The registered entry must be redirected");');
    const entry = {
      original,
      target: bundle,
      originalSha256: createHash('sha256').update(readFileSync(original)).digest('hex'),
      targetSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      interruptionSignals: ['SIGTERM'],
    };
    const directory = join(root, 'sync-command-records');
    const parent = join(root, 'sync-command-parent.mjs');
    writeFileSync(
      parent,
      `import {spawnSync,execFileSync} from 'node:child_process';
import {registerSyncCommandCapture,reconcileForkCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
const capture=registerSyncCommandCapture([${JSON.stringify(entry)}],${JSON.stringify(directory)});
const options={env:{},encoding:'utf8',stdio:'pipe',timeout:1000};
const before=JSON.stringify(options);
const spawn=spawnSync(process.execPath,[${JSON.stringify(original)},'exit'],options);
const exec=execFileSync(process.execPath,[${JSON.stringify(original)},'exit'],options);
let failure;try{execFileSync(process.execPath,[${JSON.stringify(original)},'fail'],options);}catch(error){failure={status:error.status,message:error.message,stdout:error.stdout,stderr:error.stderr,output:error.output};}
const timed=spawnSync(process.execPath,[${JSON.stringify(original)},'hold'],options);
let timedExec;try{execFileSync(process.execPath,[${JSON.stringify(original)},'hold'],options);}catch(error){timedExec={code:error.code,signal:error.signal,status:error.status,pid:error.pid};}
const delegated=execFileSync(process.execPath,['-e',"console.log('external')"],{encoding:'utf8'});
capture.restore();
const reconciled=await reconcileForkCapture(${JSON.stringify(snapshot)},${JSON.stringify(directory)},[${JSON.stringify(entry)}],${JSON.stringify(maps)});
console.log(JSON.stringify({spawn:{status:spawn.status,stdout:spawn.stdout,stderr:spawn.stderr,pid:spawn.pid,output:spawn.output},exec,failure,timed:{code:timed.error?.code,signal:timed.signal,status:timed.status,pid:timed.pid},timedExec,delegated,optionsUnchanged:JSON.stringify(options)===before,launches:capture.launches,reconciled}));`,
    );
    const result = JSON.parse(
      execFileSync(process.execPath, [parent], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(result.optionsUnchanged).toBe(true);
    expect(result.spawn.status).toBe(0);
    expect(result.spawn.stderr).toBe('');
    expect(result.spawn.output).toEqual([null, result.spawn.stdout, '']);
    expect(result.exec).toBe(result.spawn.stdout);
    expect(JSON.parse(result.exec).outputs).toEqual([
      [2, 'yes'],
      [2, 'no'],
    ]);
    expect(result.failure.status).toBe(7);
    expect(result.failure.stderr).toBe('fixture failure\n');
    expect(result.failure.message).toBe(
      `Command failed: ${process.execPath} ${original} fail\nfixture failure\n`,
    );
    for (const timed of [result.timed, result.timedExec])
      expect(timed).toMatchObject({ code: 'ETIMEDOUT', signal: 'SIGTERM', status: null });
    expect(result.delegated).toBe('external\n');
    expect(result.launches).toHaveLength(5);
    expect(result.reconciled.processes).toBe(5);
    expect(
      result.reconciled.executions.filter(
        (execution: { state: string }) => execution.state === 'interrupted',
      ),
    ).toHaveLength(2);
    expect(
      result.reconciled.executions.map((execution: { pid: number }) => execution.pid).sort(),
    ).toEqual(result.launches.map((launch: { pid: number }) => launch.pid).sort());
    const filename = join(root, 'private.ts');
    const expected = maps[filename];
    const actual = result.reconciled.maps[filename];
    if (!expected || !actual) throw new Error('Missing synchronous source counters.');
    for (const field of ['s', 'f'])
      for (const [key, hits] of Object.entries(expected[field as 's' | 'f']))
        expect(actual[field][key]).toBe(hits * 5);
    for (const [key, arms] of Object.entries(expected.b))
      expect(actual.b[key]).toEqual(arms.map((hits) => hits * 5));
    const timed = result.launches.find(
      (launch: { nativeErrorCode: string | null }) => launch.nativeErrorCode === 'ETIMEDOUT',
    );
    const closed = join(directory, `${timed.id}.close.json`);
    const retained = readFileSync(closed, 'utf8');
    const receipt = JSON.parse(retained);
    for (const nativeStop of [
      null,
      { cause: 'ENOBUFS', signal: 'SIGTERM' },
      { cause: 'ETIMEDOUT', signal: 'SIGKILL' },
    ]) {
      try {
        writeFileSync(closed, JSON.stringify({ ...receipt, nativeStop }));
        await expect(reconcileForkCapture(snapshot, directory, [entry], maps)).rejects.toThrow();
      } finally {
        writeFileSync(closed, retained);
      }
    }
    await expect(
      reconcileForkCapture(snapshot, directory, [{ ...entry, interruptionSignals: [] }], maps),
    ).rejects.toThrow('Unqualified fork interruption');
  });

  it('captures shared fork targets with explicit measured sibling identity', async () => {
    const repository = resolve(import.meta.dirname, '../../..');
    const entry = {
      original: bundle,
      target: bundle,
      originalSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      targetSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      interruptionSignals: [],
    };
    const directory = join(root, 'self-fork-records');
    const aliases = ['first-fork-alias.mjs', 'second-fork-alias.mjs'].map((filename) => {
      const original = join(root, filename);
      writeFileSync(original, 'throw new Error("The alias must be redirected");');
      return {
        ...entry,
        original,
        originalSha256: createHash('sha256').update(readFileSync(original)).digest('hex'),
      };
    });
    const entries = [entry, ...aliases];
    const parent = join(root, 'self-fork-parent.mjs');
    writeFileSync(
      parent,
      `import {fork} from 'node:child_process';
import {registerForkCapture,reconcileForkCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
const entries=${JSON.stringify(entries)};
const capture=registerForkCapture(entries,${JSON.stringify(directory)});
const messages=[];
for(const entry of entries){
 const child=fork(entry.original,['exit'],{env:{},execArgv:['--permission','--allow-fs-read=*','--max-old-space-size=64'],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});
 messages.push(await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);}));
}
await capture.settled();capture.restore();
const reconciled=await reconcileForkCapture(${JSON.stringify(snapshot)},${JSON.stringify(directory)},entries,${JSON.stringify(maps)});
const invalid=[];
for(const bad of [[entries[0],entries[0]],[entries[0],{...entries[1],target:entries[2].original,targetSha256:entries[2].originalSha256},entries[2]]]){
 try{registerForkCapture(bad,${JSON.stringify(directory)});}catch(error){invalid.push(error.message);}
}
console.log(JSON.stringify({messages,launches:capture.launches,reconciled,invalid}));`,
    );
    const result = JSON.parse(
      execFileSync(process.execPath, [parent], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(result.messages).toHaveLength(3);
    for (const message of result.messages) {
      expect(message.outputs).toEqual([
        [2, 'yes'],
        [2, 'no'],
      ]);
      expect(message.writeAllowed).toBe(false);
    }
    expect(result.launches.map((launch: { original: string }) => launch.original)).toEqual(
      entries.map((entry) => entry.original),
    );
    expect(result.launches.every((launch: { target: string }) => launch.target === bundle)).toBe(
      true,
    );
    expect(result.reconciled.processes).toBe(3);
    expect(result.invalid).toEqual([
      'Duplicate fork capture entrypoint.',
      'Ambiguous fork capture target.',
    ]);
    expect(result.reconciled.executions[0]).toMatchObject({ state: 'completed', exitCode: 0 });
    const actual = result.reconciled.maps[join(root, 'private.ts')];
    const expected = maps[join(root, 'private.ts')];
    if (!actual || !expected) throw new Error('Missing measured self-fork counters.');
    for (const field of ['s', 'f'])
      for (const [key, hits] of Object.entries(expected[field as 's' | 'f']))
        expect(actual[field][key]).toBe(hits * 3);
    for (const [key, arms] of Object.entries(expected.b))
      expect(actual.b[key]).toEqual(arms.map((hits) => hits * 3));
  });

  it('reconciles actual shutdown microtasks against observed host close', async () => {
    const repository = resolve(import.meta.dirname, '../../..');
    const entry = {
      original: bundle,
      target: bundle,
      originalSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      targetSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      interruptionSignals: [],
    };
    const directory = join(root, 'shutdown-command-records');
    const parent = join(root, 'shutdown-command-parent.mjs');
    writeFileSync(
      parent,
      `import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {registerCommandCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
const capture=registerCommandCapture([${JSON.stringify(entry)}],${JSON.stringify(directory)});
const {stdout,stderr}=await promisify(execFile)(process.execPath,[${JSON.stringify(bundle)},'exit-microtask'],{env:{}});
await capture.settled();capture.restore();
console.log(JSON.stringify({stdout,stderr,launch:capture.launches[0]}));`,
    );
    const result = JSON.parse(execFileSync(process.execPath, [parent], { encoding: 'utf8' }));
    expect(result.stderr).toBe('');
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe('3');
    const text = readFileSync(join(directory, `${result.launch.id}.counters.jsonl`), 'utf8');
    await expect(replayCounterStream(snapshot, text)).rejects.toThrow('sequence differs');
    const reconciled = await reconcileForkCapture(snapshot, directory, [entry], maps);
    expect(reconciled.status).toBe('Pass');
    expect(reconciled.processes).toBe(1);
    expect(reconciled.executions[0]).toMatchObject({
      state: 'completed',
      exitCode: 0,
      signal: null,
    });
    const actual = reconciled.maps[join(root, 'private.ts')] as Coverage;
    const expected = maps[join(root, 'private.ts')];
    if (!actual || !expected) throw new Error('Missing actual shutdown microtask map.');
    for (const field of ['statementMap', 'fnMap', 'branchMap'] as const)
      expect(actual[field]).toEqual(expected[field as keyof Coverage]);
    const close = Object.entries(actual.fnMap).find(([, fn]) => fn.loc.start.line === 16);
    const used = Object.entries(actual.fnMap).find(([, fn]) => fn.loc.start.line === 2);
    if (!close || !used) throw new Error('Missing actual shutdown microtask functions.');
    expect(actual.f[close[0]]).toBe(1);
    expect(actual.f[used[0]]).toBe(3);
    const receipt = JSON.parse(
      readFileSync(join(directory, `${result.launch.id}.close.json`), 'utf8'),
    );
    const hostClose = {
      pid: result.launch.pid,
      threadId: 0,
      code: receipt.code,
      signal: receipt.signal,
    };
    await expect(
      replayCounterStream(snapshot, text, { ...hostClose, pid: hostClose.pid + 1 }),
    ).rejects.toThrow('host close identity differs');
    await expect(replayCounterStream(snapshot, text, { ...hostClose, code: 7 })).rejects.toThrow(
      'completion differs from host close',
    );
    const records = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    const completion = records.find((record) => record.state === 'completed');
    const repeated = `${text}${JSON.stringify({ ...completion, sequence: records.length + 1 })}\n`;
    await expect(replayCounterStream(snapshot, repeated, hostClose)).rejects.toThrow(
      'Repeated native counter completion',
    );
  });

  it('drains real fork receipts before completing a captured CLI exit', async () => {
    const repository = resolve(import.meta.dirname, '../../..');
    const childEntry = {
      original: bundle,
      target: bundle,
      originalSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      targetSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      interruptionSignals: ['SIGKILL'],
    };
    const script = join(root, 'captured-cli-body.mjs');
    const wrapper = join(root, 'captured-cli-wrapper.mjs');
    const directory = join(root, 'captured-cli-children');
    writeFileSync(
      script,
      `import {fork} from 'node:child_process';const child=fork(${JSON.stringify(bundle)},['hold'],{env:{},execArgv:['--permission','--allow-fs-read=*','--max-old-space-size=64'],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});const reply=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});console.log(JSON.stringify(reply));child.kill('SIGKILL');child.unref();process.exit(7);console.log('must not run');`,
    );
    writeFileSync(
      wrapper,
      `import {runCapturedCli} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};await runCapturedCli(${JSON.stringify(script)},[${JSON.stringify(childEntry)}],${JSON.stringify(directory)});`,
    );
    let failure: { status?: number; stdout?: string; stderr?: string } | undefined;
    try {
      execFileSync(process.execPath, [wrapper], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      failure = error as typeof failure;
    }
    expect(failure?.status).toBe(7);
    expect(failure?.stderr).toBe('');
    expect(failure?.stdout).not.toContain('must not run');
    expect(JSON.parse(failure?.stdout ?? '').outputs).toEqual([
      [2, 'yes'],
      [2, 'no'],
    ]);
    const reconciled = await reconcileForkCapture(snapshot, directory, [childEntry], maps);
    expect(reconciled.processes).toBe(1);
    expect(reconciled.executions[0]).toMatchObject({ state: 'interrupted', signal: 'SIGKILL' });
  });

  it('preserves unexpected CLI import failures rather than treating them as requested exits', () => {
    const repository = resolve(import.meta.dirname, '../../..');
    const script = join(root, 'failed-captured-cli.mjs');
    const wrapper = join(root, 'failed-captured-cli-wrapper.mjs');
    writeFileSync(script, "throw new Error('original import failure');");
    writeFileSync(
      wrapper,
      `import {runCapturedCli} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};const exit=process.exit;try{await runCapturedCli(${JSON.stringify(script)},[],${JSON.stringify(join(root, 'failed-cli-children'))});}catch(error){console.log(JSON.stringify({message:error.message,restored:process.exit===exit}));}`,
    );
    expect(JSON.parse(execFileSync(process.execPath, [wrapper], { encoding: 'utf8' }))).toEqual({
      message: 'original import failure',
      restored: true,
    });
  });

  it('refuses a target that changes after registration before any child starts', () => {
    const repository = resolve(import.meta.dirname, '../../..');
    const original = join(root, 'changed-fork-original.mjs');
    writeFileSync(original, 'throw new Error("Must not start");');
    const directory = join(root, 'changed-fork-records');
    const parent = join(root, 'changed-fork-parent.mjs');
    const entry = {
      original,
      target: bundle,
      originalSha256: createHash('sha256').update(readFileSync(original)).digest('hex'),
      targetSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
    };
    writeFileSync(
      parent,
      `import {fork} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {registerForkCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
const capture = registerForkCapture([${JSON.stringify(entry)}],${JSON.stringify(directory)});
const original = readFileSync(${JSON.stringify(bundle)});
let rejected = false;
try { writeFileSync(${JSON.stringify(bundle)},Buffer.concat([original,Buffer.from('\\n')]));
  try { fork(${JSON.stringify(original)},[],{stdio:['ignore','ignore','ignore','ipc'],env:{},execArgv:[]}); }
  catch(error) { rejected = error.message.includes('changed before launch'); }
} finally { writeFileSync(${JSON.stringify(bundle)},original);capture.restore(); }
console.log(JSON.stringify({rejected,launches:capture.launches.length,files:readdirSync(${JSON.stringify(directory)})}));`,
    );
    const result = JSON.parse(
      execFileSync(process.execPath, [parent], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(result).toEqual({ rejected: true, launches: 0, files: [] });
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
