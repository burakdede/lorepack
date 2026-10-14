import { execFileSync, fork, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeCampaignSetup } from '../../../scripts/coverage_capture.mjs';
import { prepareSource, renderCoverageConfig } from '../../../scripts/coverage_configuration.mjs';
import {
  buildNativeCli,
  compiledCapturePlugin,
  createCampaignRegistry,
  createEvalCapture,
  prepareNativeCapture,
  reconcileForkCapture,
  reconcileNativeCapture,
  registerCommandCapture,
  registerSyncCommandCapture,
  replayCounterFile,
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
if (['compiler-replace','compiler-replace-failed'].includes(process.argv[2])) {
  const compilerModule=${JSON.stringify(pathToFileURL(join(dirname(createRequire(join(repository, 'package.json')).resolve('typescript/package.json')), 'lib/getExePath.js')).href)};
  const {default:getExePath}=await import(compilerModule);
  const executable=getExePath();
  if(process.argv[2]==='compiler-replace-failed') {
    try {process.execve(executable,[executable,'invalid\\u0000argument']);}
    catch(error) {if(!(error instanceof TypeError))throw error;}
  } else process.execve(executable,[executable,'--version']);
}
if(process.argv[2]==='heap-abort') {const retained=[];while(true)retained.push(new Array(100000).fill(1));}
if(process.argv[2]==='worker-run') {
  const {parentPort,workerData}=await import('node:worker_threads');
  if(workerData.nested) {
    const {Worker}=await import('node:worker_threads');
    await new Promise((resolve,reject)=>{
      const child=new Worker(new URL(import.meta.url),{argv:['worker-run'],workerData:{tag:'leaf'}});
      child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Nested worker failed')));
    });
  }
  parentPort.postMessage({argv:process.argv.slice(2),workerData});
  if(workerData.hold)setInterval(()=>{},1000);
}
if(['workers','workers-nested'].includes(process.argv[2])) {
  const {Worker}=await import('node:worker_threads');
  const messages=await Promise.all([1,2].map(tag=>new Promise((resolve,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{argv:['worker-run'],workerData:{tag,...(tag===1&&process.argv[2]==='workers-nested'?{nested:true}:{})},resourceLimits:{maxOldGenerationSizeMb:64}});
    let message;worker.once('message',value=>message=value);worker.once('error',reject);
    worker.once('exit',code=>code===0?resolve(message):reject(new Error('Worker failed')));
  })));
  console.log(JSON.stringify({messages}));
}
if(process.argv[2]==='worker-terminate') {
  const {Worker}=await import('node:worker_threads');
  const worker=new Worker(new URL(import.meta.url),{argv:['worker-run'],workerData:{hold:true}});
  await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
  worker.emit('exit',0);
  console.log(JSON.stringify({terminated:await worker.terminate()}));
}
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

  it.skipIf(['win32', 'os400'].includes(process.platform))(
    'qualifies actual native compiler image replacement without a JavaScript exit',
    async () => {
      const filename = join(root, 'compiler-replacement.jsonl');
      const fd = openSync(filename, 'wx');
      let result: ReturnType<typeof spawnSync>;
      try {
        result = spawnSync(process.execPath, [bundle, 'compiler-replace'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe', 'ignore', fd],
          env: {},
        });
      } finally {
        closeSync(fd);
      }
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe('');
      expect(String(result.stdout)).toContain('Version 7.0.2');
      const text = readFileSync(filename, 'utf8');
      const hostClose = {
        pid: result.pid,
        threadId: 0,
        code: result.status,
        signal: result.signal,
      };
      const replay = await replayCounterStream(snapshot, text, hostClose);
      expect(replay).toMatchObject({ state: 'replaced', exitCode: null, pid: result.pid });
      expect(text).not.toContain('"state":"completed"');
      const { actualMap } = await remapCounters(text, hostClose);
      for (const field of ['statementMap', 'fnMap', 'branchMap', 's', 'f', 'b'])
        expect(actualMap[field]).toEqual(maps[join(root, 'private.ts')]?.[field as keyof Coverage]);
      await expect(replayCounterStream(snapshot, text)).rejects.toThrow('requires host close');
      await expect(
        replayCounterStream(snapshot, text, { ...hostClose, pid: result.pid + 1 }),
      ).rejects.toThrow('host close identity differs');
      const records = text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      const replacement = records.find((record) => record.state === 'execve');
      expect(replacement).toBeDefined();
      await expect(
        replayCounterStream(
          snapshot,
          `${records
            .slice(0, -1)
            .map((record) => JSON.stringify(record))
            .join('\n')}\n`,
          hostClose,
        ),
      ).rejects.toThrow('completion differs from host close');
      replacement.pid += 1;
      await expect(
        replayCounterStream(
          snapshot,
          `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
          hostClose,
        ),
      ).rejects.toThrow('image replacement identity differs');
      replacement.pid -= 1;
      replacement.executableSha256 = '0'.repeat(64);
      await expect(
        replayCounterStream(
          snapshot,
          `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
          hostClose,
        ),
      ).rejects.toThrow('Unqualified native image replacement');
    },
  );

  it.skipIf(['win32', 'os400'].includes(process.platform))(
    'keeps failed image replacement attempts distinct from actual replacements',
    async () => {
      const filename = join(root, 'failed-replacement.jsonl');
      const fd = openSync(filename, 'wx');
      let result: ReturnType<typeof spawnSync>;
      try {
        result = spawnSync(process.execPath, [bundle, 'compiler-replace-failed'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe', 'ignore', fd],
          env: {},
        });
      } finally {
        closeSync(fd);
      }
      expect(result.status).toBe(0);
      expect(String(result.stderr)).toMatch(
        /^\(node:\d+\) ExperimentalWarning: process\.execve is an experimental feature/,
      );
      const text = readFileSync(filename, 'utf8');
      expect(text).toContain('"state":"execve-returned"');
      const hostClose = {
        pid: result.pid,
        threadId: 0,
        code: result.status,
        signal: result.signal,
      };
      expect(await replayCounterStream(snapshot, text, hostClose)).toMatchObject({
        state: 'completed',
        exitCode: 0,
      });
      const { actualMap } = await remapCounters(text, hostClose);
      for (const field of ['s', 'f', 'b'])
        expect(actualMap[field]).toEqual(maps[join(root, 'private.ts')]?.[field as keyof Coverage]);
    },
  );

  it.skipIf(['win32', 'os400'].includes(process.platform))(
    'rejects a receipt for an unregistered replacement image after host close',
    async () => {
      const filename = join(root, 'unregistered-replacement.jsonl');
      const fd = openSync(filename, 'wx');
      let result: ReturnType<typeof spawnSync>;
      try {
        result = spawnSync(process.execPath, [bundle, 'compiler-replace'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe', 'ignore', fd],
          env: {},
        });
      } finally {
        closeSync(fd);
      }
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const records = readFileSync(filename, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      const replacement = records.find((record) => record.state === 'execve');
      if (!replacement) throw new Error('Missing actual native image handoff.');
      replacement.executable = realpathSync(process.execPath);
      replacement.executableSha256 = createHash('sha256')
        .update(readFileSync(process.execPath))
        .digest('hex');
      const text = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
      await expect(
        replayCounterStream(snapshot, text, {
          pid: result.pid,
          threadId: 0,
          code: result.status,
          signal: result.signal,
        }),
      ).rejects.toThrow('Unqualified native image replacement');
    },
  );

  it.skipIf(['win32', 'os400'].includes(process.platform))(
    'reconciles native compiler replacement with registered launch and close receipts',
    async () => {
      const repository = resolve(import.meta.dirname, '../../..');
      const hash = createHash('sha256').update(readFileSync(bundle)).digest('hex');
      const entry = {
        original: bundle,
        target: bundle,
        originalSha256: hash,
        targetSha256: hash,
        interruptionSignals: [],
      };
      const directory = join(root, 'replacement-command-records');
      const parent = join(root, 'replacement-command-parent.mjs');
      writeFileSync(
        parent,
        `import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {registerCommandCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
const capture=registerCommandCapture([${JSON.stringify(entry)}],${JSON.stringify(directory)});
const {stdout,stderr}=await promisify(execFile)(process.execPath,[${JSON.stringify(bundle)},'compiler-replace'],{env:{}});
await capture.settled();capture.restore();console.log(JSON.stringify({stdout,stderr}));`,
      );
      const output = JSON.parse(execFileSync(process.execPath, [parent], { encoding: 'utf8' }));
      expect(output.stdout).toContain('Version 7.0.2');
      expect(output.stderr).toBe('');
      const reconciled = await reconcileForkCapture(snapshot, directory, [entry], maps);
      expect(reconciled.status).toBe('Pass');
      expect(reconciled.processes).toBe(1);
      expect(reconciled.executions[0]).toMatchObject({
        state: 'completed',
        exitCode: 0,
        counterState: 'replaced',
        counterExitCode: null,
      });
      const actual = reconciled.maps[join(root, 'private.ts')];
      for (const field of ['s', 'f', 'b'])
        expect(actual[field]).toEqual(maps[join(root, 'private.ts')]?.[field as keyof Coverage]);
    },
  );

  it('reconciles a real guarded V8 heap abort without inventing completion', async () => {
    const repository = resolve(import.meta.dirname, '../../..');
    const hash = createHash('sha256').update(readFileSync(bundle)).digest('hex');
    const entry = {
      original: bundle,
      target: bundle,
      originalSha256: hash,
      targetSha256: hash,
      interruptionSignals: [],
      nativeHeapAbort: true,
    };
    const directory = join(root, 'native-heap-abort-records');
    const parent = join(root, 'native-heap-abort-parent.mjs');
    writeFileSync(
      parent,
      `import {fork} from 'node:child_process';
import {registerForkCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
const capture=registerForkCapture([${JSON.stringify(entry)}],${JSON.stringify(directory)});
const child=fork(${JSON.stringify(bundle)},['heap-abort'],{env:{},execArgv:['--permission','--allow-fs-read=*','--max-old-space-size=64'],stdio:['ignore','pipe','pipe','ipc'],serialization:'advanced'});
const originalListeners=child.stderr.listenerCount('data');
let stderr='';child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
const closed=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,pid:child.pid}));});
await capture.settled();capture.restore();console.log(JSON.stringify({closed,stderr,originalListeners,spawnargs:child.spawnargs}));`,
    );
    const output = JSON.parse(execFileSync(process.execPath, [parent], { encoding: 'utf8' }));
    expect(output.originalListeners).toBe(0);
    expect(output.spawnargs).toEqual([
      process.execPath,
      '--permission',
      '--allow-fs-read=*',
      '--max-old-space-size=64',
      bundle,
      'heap-abort',
    ]);
    expect(output.stderr).toMatch(
      /FATAL ERROR:.*Allocation failed - JavaScript heap out of memory/,
    );
    expect(output.closed).toMatchObject(
      process.platform === 'win32'
        ? { code: 134, signal: null }
        : { code: null, signal: 'SIGABRT' },
    );
    const reconciled = await reconcileForkCapture(snapshot, directory, [entry], maps);
    expect(reconciled.status).toBe('Pass');
    expect(reconciled.processes).toBe(1);
    expect(reconciled.executions[0]).toMatchObject({
      state: 'interrupted',
      counterState: 'interrupted',
      counterExitCode: null,
    });
    await expect(
      reconcileForkCapture(snapshot, directory, [{ ...entry, nativeHeapAbort: false }], maps),
    ).rejects.toThrow('Unqualified native heap abort');
    const nativeDiagnostic = reconciled.executions[0]?.nativeAbort;
    if (!nativeDiagnostic) throw new Error('Missing reconciled native heap diagnostic.');
    expect(nativeDiagnostic.stderrSha256).toBe(
      createHash('sha256').update(output.stderr).digest('hex'),
    );
    expect(nativeDiagnostic.stderrBytes).toBe(Buffer.byteLength(output.stderr));
    const files = readdirSync(directory);
    const closeName = files.find((filename) => filename.endsWith('.close.json'));
    const evidenceName = files.find((filename) => filename.endsWith('.native-abort.json'));
    if (!closeName || !evidenceName) throw new Error('Missing native heap termination evidence.');
    const closePath = join(directory, closeName),
      evidencePath = join(directory, evidenceName);
    const closed = readFileSync(closePath, 'utf8'),
      evidence = readFileSync(evidencePath, 'utf8');
    const mutate = async (change: (value: Record<string, unknown>) => void, reason: string) => {
      const value = JSON.parse(evidence);
      change(value);
      const encoded = `${JSON.stringify(value)}\n`;
      const receipt = JSON.parse(closed);
      receipt.nativeAbort.sha256 = createHash('sha256').update(encoded).digest('hex');
      writeFileSync(evidencePath, encoded);
      writeFileSync(closePath, JSON.stringify(receipt));
      try {
        await expect(reconcileForkCapture(snapshot, directory, [entry], maps)).rejects.toThrow(
          reason,
        );
      } finally {
        writeFileSync(evidencePath, evidence);
        writeFileSync(closePath, closed);
      }
    };
    await mutate((value) => {
      value.pid = output.closed.pid + 1;
    }, 'identity differs');
    await mutate((value) => {
      value.message = 'unexplained abort';
      value.messageSha256 = createHash('sha256').update('unexplained abort').digest('hex');
    }, 'Invalid native heap-abort diagnostic');
    await mutate((value) => {
      value.heapLimitMb = 32;
    }, 'identity differs');
    writeFileSync(evidencePath, `${evidence} `);
    try {
      await expect(reconcileForkCapture(snapshot, directory, [entry], maps)).rejects.toThrow(
        'evidence hash differs',
      );
    } finally {
      writeFileSync(evidencePath, evidence);
    }
    const absent = JSON.parse(closed);
    delete absent.nativeAbort;
    writeFileSync(closePath, JSON.stringify(absent));
    try {
      await expect(reconcileForkCapture(snapshot, directory, [entry], maps)).rejects.toThrow();
    } finally {
      writeFileSync(closePath, closed);
    }
    const actual = reconciled.maps[join(root, 'private.ts')];
    for (const field of ['s', 'f', 'b'])
      expect(actual[field]).toEqual(maps[join(root, 'private.ts')]?.[field as keyof Coverage]);
  });

  it('reconciles real native counters without reading the complete stream into a string', async () => {
    const repository = resolve(import.meta.dirname, '../../..');
    const hash = createHash('sha256').update(readFileSync(bundle)).digest('hex');
    const entry = {
      original: bundle,
      target: bundle,
      originalSha256: hash,
      targetSha256: hash,
      interruptionSignals: [],
    };
    const directory = join(root, 'streaming-replay-records');
    const parent = join(root, 'streaming-replay-parent.mjs');
    writeFileSync(
      parent,
      `import {fork} from 'node:child_process';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {registerForkCapture,reconcileForkCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
const capture=registerForkCapture([${JSON.stringify(entry)}],${JSON.stringify(directory)});
const child=fork(${JSON.stringify(bundle)},['exit'],{env:{},execArgv:['--permission','--allow-fs-read=*','--max-old-space-size=64'],stdio:['ignore','ignore','pipe','ipc'],serialization:'advanced'});
let stderr='';child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Unexpected fork closure')));});
await capture.settled();capture.restore();
const read=fs.readFileSync;fs.readFileSync=function(filename,...args){if(String(filename).endsWith('.counters.jsonl'))throw new Error('Whole native counter file read');return read.call(this,filename,...args);};syncBuiltinESMExports();
const result=await reconcileForkCapture(${JSON.stringify(snapshot)},${JSON.stringify(directory)},[${JSON.stringify(entry)}],${JSON.stringify(maps)});
console.log(JSON.stringify({result,stderr}));`,
    );
    const output = JSON.parse(execFileSync(process.execPath, [parent], { encoding: 'utf8' }));
    expect(output.stderr).toBe('');
    expect(output.result.status).toBe('Pass');
    const actual = output.result.maps[join(root, 'private.ts')];
    for (const field of ['s', 'f', 'b'])
      expect(actual[field]).toEqual(maps[join(root, 'private.ts')]?.[field as keyof Coverage]);
  });

  it('keeps file and string replay identical across JSON and UTF8 chunk boundaries', async () => {
    const records = completed
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    records[0].note = '';
    const prefixBytes = Buffer.byteLength(JSON.stringify(records[0])) - 2;
    records[0].note = 'x'.repeat(64 * 1024 - 1 - prefixBytes) + '界'.repeat(100);
    const text = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    expect(Buffer.from(text).subarray(64 * 1024 - 1, 64 * 1024 + 2)).toEqual(Buffer.from('界'));
    const filename = join(root, 'chunk-boundary-counters.jsonl');
    writeFileSync(filename, text);
    expect(await replayCounterFile(snapshot, filename)).toEqual(
      await replayCounterStream(snapshot, text),
    );
    for (const invalid of ['', text.slice(0, -1), text.replace('"sequence":2', '"sequence":3')]) {
      writeFileSync(filename, invalid);
      await expect(replayCounterFile(snapshot, filename)).rejects.toThrow();
    }
    writeFileSync(filename, text);
  });

  it.each(['workers', 'workers-nested'])(
    'qualifies independent worker streams for %s with exact owned hits and original worker options',
    async (mode) => {
      const filename = join(root, `${mode}-counter-streams.jsonl`);
      const fd = openSync(filename, 'wx');
      let result: ReturnType<typeof spawnSync>;
      try {
        result = spawnSync(process.execPath, [bundle, mode], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe', 'ignore', fd],
          env: {},
        });
      } finally {
        closeSync(fd);
      }
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const output = JSON.parse(String(result.stdout).trimEnd().split('\n').at(-1) ?? '{}');
      expect(output.messages).toEqual([
        {
          argv: ['worker-run'],
          workerData: { tag: 1, ...(mode === 'workers-nested' ? { nested: true } : {}) },
        },
        { argv: ['worker-run'], workerData: { tag: 2 } },
      ]);
      const replay = await replayCounterFile(snapshot, filename, {
        pid: result.pid,
        threadId: 0,
        code: result.status,
        signal: result.signal,
      });
      const count = mode === 'workers-nested' ? 3 : 2;
      const threads = replay.threads;
      if (!threads || threads.length !== count || !threads[0])
        throw new Error('Missing worker lifecycles.');
      expect(threads).toHaveLength(count);
      expect(new Set(threads.map((thread: { threadId: number }) => thread.threadId)).size).toBe(
        count,
      );
      const actual = replay.maps[join(root, 'private.ts')];
      const expected = maps[join(root, 'private.ts')];
      if (!actual || !expected) throw new Error('Missing real owned worker counts.');
      for (const field of ['s', 'f'])
        for (const [key, hits] of Object.entries(expected[field as 's' | 'f']))
          expect(actual[field][key]).toBe(hits * (count + 1));
      for (const [key, hits] of Object.entries(expected.b))
        expect(actual.b[key]).toEqual(hits.map((value) => value * (count + 1)));
      const host = { pid: result.pid, threadId: 0, code: result.status, signal: result.signal };
      const records = readFileSync(filename, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(await replayCounterStream(snapshot, readFileSync(filename, 'utf8'), host)).toEqual(
        replay,
      );
      const workerId = threads[0].id;
      const reject = async (values: typeof records, reason: string) => {
        const sequences = new Map<string, number>();
        const rootId = records[0].id;
        for (const record of values) {
          const id = record.id ?? rootId;
          record.sequence = (sequences.get(id) ?? 0) + 1;
          sequences.set(id, record.sequence);
        }
        await expect(
          replayCounterStream(
            snapshot,
            `${values.map((value) => JSON.stringify(value)).join('\n')}\n`,
            host,
          ),
        ).rejects.toThrow(reason);
      };
      await reject(
        structuredClone(records).filter((record) => record.state !== 'worker-closed'),
        'host close missing',
      );
      await reject(
        structuredClone(records).filter(
          (record) => !(record.state === 'completed' && record.id === workerId),
        ),
        'completion missing',
      );
      await reject(
        structuredClone(records).filter((record) => record.state !== 'worker-started'),
        'lifecycle differs',
      );
      const mismatch = structuredClone(records);
      mismatch.find((record) => record.state === 'worker-closed').exitCode = 12;
      await reject(mismatch, 'completion differs');
      const late = structuredClone(records);
      late.push(
        structuredClone(
          records.find((record) => record.id === workerId && record.state === 'counter'),
        ),
      );
      await reject(late, 'continued after host close');
      const orphan = structuredClone(records);
      orphan.find((record) => record.id === workerId && record.state === 'counter').id = 'missing';
      await reject(orphan, 'Unknown native counter context');
    },
  );

  it('retains terminated worker hits without inventing completion or accepting manual exit events', async () => {
    const filename = join(root, 'terminated-worker-counters.jsonl');
    const fd = openSync(filename, 'wx');
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(process.execPath, [bundle, 'worker-terminate'], {
        encoding: 'utf8',
        env: {},
        stdio: ['ignore', 'pipe', 'pipe', 'ignore', fd],
      });
    } finally {
      closeSync(fd);
    }
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const text = readFileSync(filename, 'utf8');
    const host = { pid: result.pid, threadId: 0, code: result.status, signal: result.signal };
    const replay = await replayCounterStream(snapshot, text, host);
    const threads = replay.threads;
    if (threads?.length !== 1) throw new Error('Missing terminated worker lifecycle.');
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      state: 'interrupted',
      exitCode: null,
      hostClose: { parentId: replay.id, exitCode: 1, terminationRequested: true },
    });
    const records = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.filter((record) => record.state === 'worker-closed')).toHaveLength(1);
    expect(records.find((record) => record.state === 'worker-closed').exitCode).toBe(1);
    expect(records.some((record) => record.state === 'completed' && record.threadId > 0)).toBe(
      false,
    );
    const actual = replay.maps[join(root, 'private.ts')];
    const expected = maps[join(root, 'private.ts')];
    if (!actual || !expected) throw new Error('Missing terminated worker execution.');
    for (const field of ['s', 'f'])
      for (const [key, hits] of Object.entries(expected[field as 's' | 'f']))
        expect(actual[field][key]).toBe(hits * 2);
    const invalid = records.filter((record) => record.state !== 'worker-terminate');
    let parentSequence = 0;
    for (const record of invalid)
      if (!record.id || record.id === records[0].id) record.sequence = ++parentSequence;
    await expect(
      replayCounterStream(
        snapshot,
        `${invalid.map((record) => JSON.stringify(record)).join('\n')}\n`,
        host,
      ),
    ).rejects.toThrow('completion missing');
  });

  async function remapCounters(
    text: string,
    hostClose?: { pid: number; threadId: number; code: number | null; signal: string | null },
  ) {
    const actual = await replayCounterStream(snapshot, text, hostClose);
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

  describe('complete CLI measurement layout', () => {
    let scenario: {
      project: string;
      repository: string;
      captured: { root: string; included: { path: string; sha256: string }[] };
      native: string;
      output: string;
      before: Buffer[];
      built: Awaited<ReturnType<typeof buildNativeCli>>;
    };
    const expectedOutput = `${[
      { marker: 'measured', writeAllowed: false },
      { marker: 'measured', writeAllowed: false },
      { marker: 'measured', execArgv: ['--max-old-space-size=128'] },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n')}\n`;
    beforeAll(async () => {
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
      writeFileSync(
        join(project, 'packages/backend-local/migrations/001_fixture.sql'),
        'SELECT 1;',
      );
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
      await prepareNativeCapture(captured, preparation, native, '__LOREPACK_CAMPAIGN_COVERAGE__');
      const before = included.map((entry) =>
        readFileSync(join(project, entry.path.replace('/src/', '/dist/').replace(/\.ts$/, '.js'))),
      );
      const { bundleCli } = await import('../../../scripts/bundle-cli.mjs');
      await bundleCli({ root: project });
      const output = join(project, 'measurement/dist');
      const built = await buildNativeCli(
        captured,
        native,
        output,
        '__LOREPACK_CAMPAIGN_COVERAGE__',
      );
      scenario = { project, repository, captured, native, output, before, built };
    });
    beforeEach(() => {
      for (const path of [
        scenario.built.launch.captureDirectory,
        join(scenario.project, 'cli-counters'),
        join(scenario.project, 'nested-captures'),
      ])
        rmSync(path, { recursive: true, force: true });
    });
    afterEach(() => {
      expect(
        scenario.captured.included.map((entry) =>
          readFileSync(
            join(scenario.project, entry.path.replace('/src/', '/dist/').replace(/\.ts$/, '.js')),
          ),
        ),
      ).toEqual(scenario.before);
    });
    it('builds separate CLI artifacts without changing ordinary output', async () => {
      const { built, output, captured, native, project } = scenario;
      const launch = built.launch;
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
      expect(JSON.parse(readFileSync(join(output, 'launch.receipts.json'), 'utf8'))).toEqual(
        launch,
      );
      expect(launch.entrySha256).toBe(
        createHash('sha256').update(readFileSync(launch.entry)).digest('hex'),
      );
      await expect(
        buildNativeCli(captured, native, join(project, 'packages/cli/dist')),
      ).rejects.toThrow('ordinary');
      await expect(buildNativeCli(captured, native, output)).rejects.toThrow('empty');
    });
    it.each([
      ['sync', 'separate'],
      ['async', 'separate'],
      ['sync', 'equals'],
      ['async', 'equals'],
    ] as const)('retains registered CLI preloads through %s calls (%s)', async (mode, form) => {
      const { project, captured, built } = scenario;
      const { default: childProcess } = await import('node:child_process');
      const preload = join(project, 'user-preload.mjs');
      writeFileSync(preload, 'console.log(JSON.stringify({preload:process.execArgv}));\n');
      const prefix =
        form === 'separate'
          ? ['--import', pathToFileURL(preload).href]
          : [`--import=${pathToFileURL(preload).href}`];
      const args = [...prefix, join(project, 'packages/cli/dist/public-entry.js')];
      const expected = childProcess.spawnSync(process.execPath, args, {
        env: {},
        encoding: 'utf8',
      });
      expect(expected.status).toBe(7);
      expect(expected.stderr).toBe('');
      const registry = createCampaignRegistry(captured, built.launch);
      const directory = join(project, `preload-${mode}-${form}-parent-counters`);
      const synchronous = registerSyncCommandCapture(registry.commandEntries, directory);
      const asynchronous = registerCommandCapture(registry.commandEntries, directory);
      try {
        if (mode === 'sync') {
          const actual = childProcess.spawnSync(process.execPath, args, {
            env: {},
            encoding: 'utf8',
          });
          expect(actual.status).toBe(expected.status);
          expect(actual.stdout).toBe(expected.stdout);
          expect(actual.stderr).toBe(expected.stderr);
        } else {
          const child = childProcess.spawn(process.execPath, args, {
            env: {},
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const output: Buffer[] = [];
          const errors: Buffer[] = [];
          child.stdout.on('data', (value) => output.push(value));
          child.stderr.on('data', (value) => errors.push(value));
          const code = await new Promise((resolve, reject) => {
            child.once('close', resolve);
            child.once('error', reject);
          });
          expect(code).toBe(expected.status);
          expect(Buffer.concat(output).toString()).toBe(expected.stdout);
          expect(Buffer.concat(errors).toString()).toBe(expected.stderr);
        }
        await asynchronous.settled();
      } finally {
        asynchronous.restore();
        synchronous.restore();
      }
      const parent = await reconcileForkCapture(captured, directory, registry.commandEntries);
      expect(parent.status).toBe('Pass');
      expect(parent.processes).toBe(1);
      const children = await reconcileForkCapture(captured, built.launch.captureDirectory, [
        ...registry.forkEntries,
        ...registry.commandEntries,
      ]);
      expect(children.status).toBe('Pass');
      expect(children.processes).toBe(3);
    });

    it('reconciles actual parent counters and every CLI child', async () => {
      const { project, captured, built } = scenario;
      const launch = built.launch;
      const parentDirectory = join(project, 'cli-counters');
      const parentEntry = {
        original: launch.entry,
        target: launch.entry,
        originalSha256: launch.entrySha256,
        targetSha256: launch.entrySha256,
        interruptionSignals: [],
      };
      const parentCapture = registerSyncCommandCapture([parentEntry], parentDirectory);
      let result: import('node:child_process').SpawnSyncReturns<string>;
      try {
        const { spawnSync } = await import('node:child_process');
        result = spawnSync(process.execPath, [launch.entry], {
          env: {},
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } finally {
        parentCapture.restore();
      }
      expect(parentCapture.launches).toHaveLength(1);
      const counterFile = join(parentDirectory, `${parentCapture.launches[0].id}.counters.jsonl`);
      const parentEvidence = await reconcileForkCapture(captured, parentDirectory, [parentEntry]);
      expect(parentEvidence.status).toBe('Pass');
      expect(parentEvidence.processes).toBe(1);
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
      expect(
        children.executions.filter((execution) => execution.state === 'completed'),
      ).toHaveLength(1);
      expect(Object.keys(children.maps)).toHaveLength(4);
      const parent = await replayCounterStream(captured, readFileSync(counterFile, 'utf8'));
      expect(parent.state).toBe('completed');
      expect(parent.exitCode).toBe(7);
      expect(Object.keys(parent.maps)).toHaveLength(2);
    });
    it('captures worker entrypoints and restores rejected registration', async () => {
      const { project, repository, captured, built } = scenario;
      const launch = built.launch;
      const registry = createCampaignRegistry(captured, launch);
      expect(registry.forkEntries).toHaveLength(6);
      expect(registry.commandEntries).toHaveLength(10);
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
      const workerResult = JSON.parse(
        execFileSync(process.execPath, [worker], { encoding: 'utf8' }),
      );
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
      expect(workerResult.cli.stdout).toBe(expectedOutput);
      expect(workerResult.registrationRejected).toBe(true);
      expect(workerResult.forkRestored).toBe(true);
      const workerCapture = await reconcileForkCapture(captured, launch.captureDirectory, [
        ...registry.forkEntries,
        ...registry.commandEntries,
      ]);
      expect(workerCapture.status).toBe('Pass');
      expect(workerCapture.processes).toBe(7);
    });
    it('authenticates a large artifact graph with bounded resident memory', () => {
      const { output, captured, built } = scenario;
      const large = join(output, 'large-authentication.map');
      const block = Buffer.alloc(1024 * 1024);
      const hash = createHash('sha256');
      const descriptor = openSync(large, 'wx');
      try {
        for (let index = 0; index < 32; index++) {
          expect(writeSync(descriptor, block)).toBe(block.length);
          hash.update(block);
        }
      } finally {
        closeSync(descriptor);
      }
      const launch = {
        ...built.launch,
        artifacts: [...built.launch.artifacts, { path: large, sha256: hash.digest('hex') }],
      };
      const parent = join(output, 'large-graph-parent.mjs');
      const repository = resolve(import.meta.dirname, '../../..');
      writeFileSync(
        parent,
        `import {createCampaignRegistry} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
const before=process.resourceUsage().maxRSS*1024;
const registry=createCampaignRegistry(${JSON.stringify(captured)},${JSON.stringify(launch)});
console.log(JSON.stringify({delta:process.resourceUsage().maxRSS*1024-before,forks:registry.forkEntries.length,commands:registry.commandEntries.length}));`,
      );
      const result = JSON.parse(
        execFileSync(process.execPath, [parent], { encoding: 'utf8', env: {} }),
      );
      expect(result.forks).toBeGreaterThan(0);
      expect(result.commands).toBeGreaterThan(0);
      expect(result.delta).toBeLessThan(8 * 1024 * 1024);
      appendFileSync(large, 'changed final byte');
      const rejected = spawnSync(process.execPath, [parent], { encoding: 'utf8', env: {} });
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toContain('Native CLI artifact differs from its receipt.');
    });
    it.each([
      'query-child.js',
      'archive-verify-child.js',
      'public-entry.js',
      'measurement-public-entry.js',
      'measurement-query-child.js',
      'capture-bootstrap.mjs',
      'capture-script-fd5.mjs',
      'shared-chunk',
    ])('rejects changed measurement artifact %s', async (filename) => {
      const { output, captured, built } = scenario;
      const launch = built.launch;
      const sharedChunk = readdirSync(output).find((filename) =>
        /^chunk-[A-Z0-9]{8}\.js$/.test(filename),
      );
      expect(sharedChunk).toBeDefined();

      const changed = join(
        output,
        filename === 'shared-chunk' ? (sharedChunk as string) : filename,
      );
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
    });
    it('retains explicit fork custody inside a campaign worker', async () => {
      const { project, repository, captured, built } = scenario;
      const registry = createCampaignRegistry(captured, built.launch);
      const setup = join(project, 'nested-fork-setup.mjs');
      writeCampaignSetup(captured, built.launch, setup);
      const driver = join(project, 'nested-fork-driver.mjs');
      writeFileSync(
        driver,
        `const {marker}=await import(${JSON.stringify(pathToFileURL(join(project, 'packages/core/dist/shared.js')).href)});process.send(marker());process.disconnect();`,
      );
      const directory = join(project, 'explicit-fork-captures');
      const foreign = join(project, 'different-fork-captures');
      writeFileSync(
        join(project, 'nested-fork.test.ts'),
        `import {expect,test} from 'vitest';
import {fork,spawnSync} from 'node:child_process';
import {registerForkCapture,registerCommandCapture,reconcileForkCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
test('retains both positive and negative explicit custody',async()=>{
 const entries=${JSON.stringify(registry.commandEntries)};
 const directory=${JSON.stringify(directory)};
 const foreign=${JSON.stringify(foreign)};
 for(const auditDirectory of [directory,foreign]) {
  const forks=registerForkCapture([],auditDirectory,true);
  const commands=registerCommandCapture(entries,directory);
  try {
   const child=fork(${JSON.stringify(driver)},[],{env:{},execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
   let message;child.on('message',value=>{message=value;});
   const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
   expect(code).toBe(0);expect(message).toBe('measured');
   await commands.settled();await forks.settled();
  } finally {commands.restore();forks.restore();}
 }
 const captured=await reconcileForkCapture(${JSON.stringify(captured)},directory,entries);
 expect(captured.status).toBe('Pass');expect(captured.processes).toBe(2);
 await expect(reconcileForkCapture(${JSON.stringify(captured)},foreign,entries)).rejects.toThrow('Unregistered Node launches');
 const restored=spawnSync(process.execPath,[${JSON.stringify(join(project, 'packages/cli/dist/public-entry.js'))}],{encoding:'utf8',env:{}});
 expect(restored.status).toBe(7);expect(restored.stderr).toBe('');
 expect(restored.stdout).toContain('"marker":"measured"');
});`,
      );
      const config = join(project, 'nested-fork.config.mjs');
      writeFileSync(
        config,
        `export default ${JSON.stringify({
          root: project,
          test: { include: ['nested-fork.test.ts'], setupFiles: [setup] },
        })};`,
      );
      const vitest = join(
        dirname(createRequire(join(repository, 'package.json')).resolve('vitest/package.json')),
        'vitest.mjs',
      );
      execFileSync(process.execPath, [vitest, 'run', '--config', config], {
        cwd: project,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const campaign = await reconcileForkCapture(captured, built.launch.captureDirectory, [
        ...registry.forkEntries,
        ...registry.commandEntries,
      ]);
      expect(campaign.status).toBe('Pass');
      expect(campaign.processes).toBe(4);
    });

    it('captures automatic workers, nested collectors and explicit streams', async () => {
      const { project, repository, captured, built } = scenario;
      const launch = built.launch;
      const registry = createCampaignRegistry(captured, launch);
      const setupFile = join(project, 'auto-worker-setup.mjs');
      writeCampaignSetup(captured, launch, setupFile);
      const ownedEval = `const {marker}=await import(${JSON.stringify(pathToFileURL(join(project, 'packages/core/dist/shared.js')).href)});console.log(marker());`;
      const temporary = join(project, 'temporary-driver.mjs');
      writeFileSync(temporary, ownedEval);
      const separateDriver = join(project, 'separate-stream-driver.mjs');
      writeFileSync(
        separateDriver,
        `import {writeSync} from 'node:fs';writeSync(4,'fixture');${ownedEval}`,
      );
      const automaticTest = join(project, 'automatic.test.ts');
      writeFileSync(
        automaticTest,
        `import {expect,test} from 'vitest';
import {spawnSync} from 'node:child_process';
import {openSync,closeSync,readFileSync} from 'node:fs';
import {registerSyncCommandCapture,reconcileForkCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
test('restores campaign capture after a nested explicit collector',async()=>{
 const entries=${JSON.stringify(registry.commandEntries)};
 const directory=${JSON.stringify(join(project, 'nested-captures'))};
 const nested=registerSyncCommandCapture(entries,directory);
 try {
  expect(()=>registerSyncCommandCapture(entries,directory)).toThrow('already registered');
  const result=spawnSync(process.execPath,[${JSON.stringify(join(project, 'packages/cli/dist/public-entry.js'))}],{encoding:'utf8',env:{}});
  expect(result.status).toBe(7);expect(result.stderr).toBe('');
 } finally {nested.restore();}
 const captured=await reconcileForkCapture(${JSON.stringify(captured)},directory,entries);
 expect(captured.status).toBe('Pass');expect(captured.processes).toBe(1);
});
test('captures the ordinary CLI automatically',()=>{
 const result=spawnSync(process.execPath,[${JSON.stringify(join(project, 'packages/cli/dist/public-entry.js'))}],{encoding:'utf8',env:{}});
 expect(result.status).toBe(7);expect(result.stderr).toBe('');
});
test('preserves a caller stream during automatic capture',()=>{
 const file=${JSON.stringify(join(project, 'caller-stream.txt'))};
 const fd=openSync(file,'wx');
 try {
  const result=spawnSync(process.execPath,[${JSON.stringify(separateDriver)}],{encoding:'utf8',env:{},stdio:['ignore','pipe','pipe','ignore',fd]});
  expect(result.status).toBe(0);expect(result.stdout).toBe('measured\\n');expect(result.stderr).toBe('');
  expect(result.output).toHaveLength(5);
 } finally {closeSync(fd);}
 expect(readFileSync(file,'utf8')).toBe('fixture');
});
test('captures unregistered eval and temporary drivers automatically',()=>{
 for(const args of [['--input-type=module','-e',${JSON.stringify(ownedEval)}],[${JSON.stringify(temporary)}]]) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',env:{}});
  expect(result.status).toBe(0);expect(result.stdout).toBe('measured\\n');expect(result.stderr).toBe('');
 }
});`,
      );
      const automaticConfig = join(project, 'automatic.config.mjs');
      writeFileSync(
        automaticConfig,
        `export default ${JSON.stringify({
          root: project,
          test: { include: ['automatic.test.ts'], setupFiles: [setupFile] },
        })};`,
      );
      const vitest = join(
        dirname(createRequire(join(repository, 'package.json')).resolve('vitest/package.json')),
        'vitest.mjs',
      );
      execFileSync(process.execPath, [vitest, 'run', '--config', automaticConfig], {
        cwd: project,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const automaticCapture = await reconcileForkCapture(captured, launch.captureDirectory, [
        ...registry.forkEntries,
        ...registry.commandEntries,
      ]);
      expect(automaticCapture.status).toBe('Pass');
      expect(automaticCapture.processes).toBe(10);
    });
  });

  describe('owned compiled eval and script execution', () => {
    let fixture: Awaited<ReturnType<typeof prepareFixture>>;
    const forms = [
      'plain',
      'import-separate',
      'import-equals',
      'permission-read',
      'permission-write',
      'no-warnings',
      'worker-prefixes',
    ].map((name, index) => [name, index] as const);
    beforeAll(async () => {
      fixture = await prepareFixture();
    });
    afterEach(() => {
      expect(readFileSync(join(fixture.project, 'packages/core/dist/witness.js'))).toEqual(
        fixture.artifact,
      );
    });
    async function prepareFixture() {
      const project = join(root, 'eval-project');
      const path = 'packages/core/src/witness.ts';
      const source =
        'export function choose(flag = false) { if (flag) return 1; return 2; }\nexport function unused() { return 9; }\n';
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, 'package.json'), '{"type":"module"}');
      writeFileSync(join(project, path), source);
      const repository = resolve(import.meta.dirname, '../../..');
      const require = createRequire(join(repository, 'package.json'));
      const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
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
          join(project, 'packages/core/src'),
          '--outDir',
          join(project, 'packages/core/dist'),
          join(project, path),
        ],
        { stdio: 'pipe' },
      );
      const snapshot = {
        root: project,
        included: [{ path, sha256: createHash('sha256').update(source).digest('hex') }],
      };
      const preparations = join(project, 'preparations');
      mkdirSync(preparations);
      writeFileSync(
        join(preparations, `${createHash('sha256').update(path).digest('hex')}.json`),
        JSON.stringify(prepareSource(snapshot, join(project, path), source, null)),
      );
      const native = join(project, 'native');
      await prepareNativeCapture(snapshot, preparations, native);
      const bootstrap = join(project, 'capture.mjs');
      writeFileSync(
        bootstrap,
        `import {registerCompiledCapture} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};registerCompiledCapture(${JSON.stringify(snapshot)},${JSON.stringify(native)},4);`,
      );
      const entry = pathToFileURL(join(project, 'packages/core/dist/witness.js')).href;
      const code = `const {choose}=await import(${JSON.stringify(entry)});console.log(JSON.stringify([choose(),choose(true)]));`;
      const deniedFile = join(project, 'denied-write.txt');
      const observable = `const {choose}=await import(${JSON.stringify(entry)});const writeAllowed=process.permission?.has('fs.write',${JSON.stringify(deniedFile)})??true;let deniedWrite=null;if(!writeAllowed){try{const {writeFileSync}=await import('node:fs');writeFileSync(${JSON.stringify(deniedFile)},'test');}catch(error){deniedWrite=error.code;}}console.log(JSON.stringify({result:[choose(),choose(true)],execArgv:process.execArgv,argv:process.argv,cwd:process.cwd(),env:process.env,url:import.meta.url,preloaded:globalThis.userPreloadRan??false,writeAllowed,deniedWrite,required:globalThis.commonJsPreloadRan??false}));`;
      const arguments_ = ['--input-type=module', '--max-old-space-size=64', '-e', observable];
      const userPreload = join(project, 'user-preload.mjs');
      writeFileSync(userPreload, 'globalThis.userPreloadRan = true;');
      const commonJsPreload = join(project, 'user-preload.cjs');
      writeFileSync(commonJsPreload, 'globalThis.commonJsPreloadRan = true;');
      const launchArguments = [
        arguments_,
        ['--import', pathToFileURL(userPreload).href, ...arguments_],
        [`--import=${pathToFileURL(userPreload).href}`, ...arguments_],
        ['--permission', '--allow-fs-read=*', ...arguments_],
        ['--permission', '--allow-fs-read', '*', `--allow-fs-write=${project}`, ...arguments_],
        ['--no-warnings', ...arguments_],
        [
          '--experimental-import-meta-resolve',
          '--require',
          commonJsPreload,
          '--conditions=node',
          '--conditions',
          'development',
          ...arguments_,
        ],
      ];
      const script = join(project, 'temporary.mjs');
      writeFileSync(script, observable);
      const scriptArguments = [
        '--max-old-space-size=64',
        script,
        '--eval',
        'ordinary application argument',
      ];
      const scriptLaunchArguments = [
        scriptArguments,
        ['--import', pathToFileURL(userPreload).href, ...scriptArguments],
        [`--import=${pathToFileURL(userPreload).href}`, ...scriptArguments],
        ['--permission', '--allow-fs-read=*', ...scriptArguments],
        ['--permission', '--allow-fs-read', '*', `--allow-fs-write=${project}`, ...scriptArguments],
        ['--no-warnings', ...scriptArguments],
        [
          '--experimental-import-meta-resolve',
          '--require',
          commonJsPreload,
          '--conditions=node',
          '--conditions',
          'development',
          ...scriptArguments,
        ],
      ];

      const preload = createEvalCapture(snapshot, native, join(project, 'automatic-preload.mjs'));
      const scriptPreload = createEvalCapture(
        snapshot,
        native,
        join(project, 'script-preload.mjs'),
        'script-import',
      );
      const artifact = readFileSync(join(project, 'packages/core/dist/witness.js'));
      return {
        project,
        path,
        snapshot,
        bootstrap,
        entry,
        code,
        observable,
        arguments_,
        launchArguments,
        scriptLaunchArguments,
        preload,
        scriptPreload,
        artifact,
      };
    }
    it('captures owned compiled imports from a real Node eval without changing results', async () => {
      const { project, path, snapshot, bootstrap, code } = fixture;
      const ordinary = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
        encoding: 'utf8',
        env: {},
      });
      const counters = join(project, 'counters.jsonl');
      const fd = openSync(counters, 'wx');
      let result: import('node:child_process').SpawnSyncReturns<string>;
      try {
        const { spawnSync } = await import('node:child_process');
        result = spawnSync(
          process.execPath,
          ['--import', pathToFileURL(bootstrap).href, '--input-type=module', '-e', code],
          { encoding: 'utf8', env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ignore', fd] },
        );
      } finally {
        closeSync(fd);
      }
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(ordinary);
      const replay = await replayCounterStream(snapshot, readFileSync(counters, 'utf8'));
      expect(replay.state).toBe('completed');
      const map = (replay.maps as Record<string, Coverage>)[join(project, path)];
      if (!map) throw new Error('Missing eval-import coverage.');
      expect(Object.values(map.f).sort()).toEqual([0, 2]);
      expect(Object.values(map.s).some((value) => value > 0)).toBe(true);
    });
    it.each(forms)('captures eval prefix %s without changing execution', async (name, index) => {
      const { project, path, snapshot, preload } = fixture;
      const args = fixture.launchArguments[index];
      if (!args) throw new Error('Missing eval launch fixture.');
      const { default: processes } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const expected = processes.execFileSync(process.execPath, args, {
        encoding: 'utf8',
        env: {},
      });
      if (index === 3)
        expect(JSON.parse(expected)).toMatchObject({
          writeAllowed: false,
          deniedWrite: 'ERR_ACCESS_DENIED',
        });
      if (index === 4)
        expect(JSON.parse(expected)).toMatchObject({ writeAllowed: true, deniedWrite: null });
      const directory = join(project, `eval-${name}-counters`);
      const asynchronous = registerCommandCapture([preload], directory);
      const synchronous = registerSyncCommandCapture([preload], directory);
      try {
        const actual = await promisify(processes.execFile)(process.execPath, args, {
          encoding: 'utf8',
          env: {},
        });
        expect(actual.stdout).toBe(expected);
        expect(actual.stderr).toBe('');
        const synced = processes.spawnSync(process.execPath, args, { encoding: 'utf8', env: {} });
        expect(synced.status).toBe(0);
        expect(synced.stdout).toBe(expected);
        expect(synced.stderr).toBe('');
        await asynchronous.settled();
      } finally {
        synchronous.restore();
        asynchronous.restore();
      }
      const automatic = await reconcileForkCapture(snapshot, directory, [preload]);
      expect(automatic.status).toBe('Pass');
      expect(automatic.processes).toBe(2);
      const map = (automatic.maps as Record<string, Coverage>)[join(project, path)];
      if (!map) throw new Error('Missing automatic eval coverage.');
      expect(Object.values(map.f).sort()).toEqual([0, 4]);
    });
    it.each(forms)(
      'captures temporary script prefix %s without changing execution',
      async (name, index) => {
        const { project, path, snapshot, scriptPreload } = fixture;
        const args = fixture.scriptLaunchArguments[index];
        if (!args) throw new Error('Missing script launch fixture.');
        const { default: processes } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const options = { cwd: project, encoding: 'utf8' as const, env: {} };
        const expected = processes.execFileSync(process.execPath, args, options);
        const directory = join(project, `script-${name}-counters`);
        const asynchronous = registerCommandCapture([scriptPreload], directory);
        const synchronous = registerSyncCommandCapture([scriptPreload], directory);
        try {
          const actual = await promisify(processes.execFile)(process.execPath, args, options);
          expect(actual.stdout).toBe(expected);
          expect(actual.stderr).toBe('');
          expect(processes.execFileSync(process.execPath, args, options)).toBe(expected);
          await asynchronous.settled();
        } finally {
          synchronous.restore();
          asynchronous.restore();
        }
        const captured = await reconcileForkCapture(snapshot, directory, [scriptPreload]);
        expect(captured.status).toBe('Pass');
        expect(captured.processes).toBe(2);
        const map = (captured.maps as Record<string, Coverage>)[join(project, path)];
        if (!map) throw new Error('Missing temporary script coverage.');
        expect(Object.values(map.f).sort()).toEqual([0, 4]);
      },
    );
    it('rejects an unregistered launch without recording its eval text', async () => {
      const { project, snapshot, preload, observable, arguments_ } = fixture;
      const args = ['--no-warnings', ...arguments_];
      const { default: processes } = await import('node:child_process');
      const expected = processes.execFileSync(process.execPath, args, {
        encoding: 'utf8',
        env: {},
      });
      const directory = join(project, 'unregistered-counters');
      const audited = registerSyncCommandCapture([], directory, true);
      try {
        expect(processes.execFileSync(process.execPath, args, { encoding: 'utf8', env: {} })).toBe(
          expected,
        );
      } finally {
        audited.restore();
      }
      const files = readdirSync(directory);
      expect(files).toHaveLength(1);
      const record = readFileSync(join(directory, files[0] as string), 'utf8');
      expect(record).not.toContain(observable);
      expect(JSON.parse(record).optionNames).toContain('--no-warnings');
      await expect(reconcileForkCapture(snapshot, directory, [preload])).rejects.toThrow(
        'Unregistered Node launches',
      );
    });
  });

  it.each([
    'clean',
    'dual',
    'changed-js',
    'changed-map',
    'changed-source',
    'changed-input',
    'changed-preparation',
  ] as const)(
    'captures a freshly compiled graph with strict artifact identity: %s',
    async (mode) => {
      const repository = resolve(import.meta.dirname, '../../..');
      const directory =
        mode === 'dual'
          ? join(root, 'packages/witness/dist/generated-graph-dual')
          : join(root, `generated-graph-${mode}`);
      mkdirSync(directory, { recursive: true });
      const parent = join(root, `generated-graph-parent-${mode}.mjs`);
      const companionCounters = join(root, 'generated-graph-companion-counters.jsonl');
      const observation = join(root, 'generated-graph-companion-observation.json');
      const tampered =
        mode === 'changed-source'
          ? join(root, 'private.ts')
          : mode === 'changed-input'
            ? join(root, 'dist/private.js')
            : mode === 'changed-preparation'
              ? join(
                  root,
                  'stream-preparations',
                  `${createHash('sha256').update('private.ts').digest('hex')}.json`,
                )
              : join(directory, mode === 'changed-map' ? 'private.js.map' : 'private.js');
      const require = createRequire(join(repository, 'package.json'));
      const compiler = pathToFileURL(require.resolve('esbuild')).href;
      if (mode === 'dual')
        await prepareNativeCapture(
          snapshot,
          join(root, 'preparations'),
          join(root, 'graph-campaign-preparations'),
          '__LOREPACK_CAMPAIGN_COVERAGE__',
        );
      writeFileSync(
        parent,
        `import {pathToFileURL} from 'node:url';
import {appendFileSync,readFileSync,writeFileSync,openSync} from 'node:fs';
import {build} from ${JSON.stringify(compiler)};
import {registerCompiledCapture,captureCompiledBuild} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/coverage_instrumented.mjs')).href)};
const capture=registerCompiledCapture(${JSON.stringify(snapshot)},${JSON.stringify(join(root, 'stream-preparations'))},4);
const externalCampaign=Object.hasOwn(globalThis,'__LOREPACK_CAMPAIGN_COVERAGE__');
let companionDescriptor=null;
if(${JSON.stringify(mode)}==='dual'&&!externalCampaign){
 companionDescriptor=openSync(${JSON.stringify(companionCounters)},'wx');
 while(companionDescriptor<=4)companionDescriptor=openSync(${JSON.stringify(companionCounters)},'a');
}
const companion=companionDescriptor===null?null:registerCompiledCapture(${JSON.stringify(snapshot)},${JSON.stringify(join(root, 'graph-campaign-preparations'))},companionDescriptor,'__LOREPACK_CAMPAIGN_COVERAGE__');
if(${JSON.stringify(mode)}==='dual'){
 let rejected=false;try{await captureCompiledBuild(build,{},${JSON.stringify(directory)});}catch(error){rejected=error.message==='Generated capture requires an explicit counter namespace.';}
 if(!rejected)throw new Error('Ambiguous generated graph was accepted');
}
await captureCompiledBuild(build,{entryPoints:[${JSON.stringify(join(root, 'dist/private.js'))}],outdir:${JSON.stringify(directory)},bundle:true,format:'esm',platform:'node',sourcemap:true},${JSON.stringify(directory)},'__LOREPACK_NATIVE_COVERAGE__');
const tampered=${JSON.stringify(tampered)};
const retained=['clean','dual'].includes(${JSON.stringify(mode)})?null:readFileSync(tampered);
if(retained)appendFileSync(tampered,' ');
try {
const {PrivateWitness}=await import(pathToFileURL(${JSON.stringify(join(directory, 'private.js'))}).href);
const instance=new PrivateWitness();const result=[await instance.run(true),await instance.run(false)];
if(${JSON.stringify(mode)}==='dual')writeFileSync(${JSON.stringify(observation)},JSON.stringify({external:externalCampaign,descriptor:companionDescriptor,maps:Object.keys(globalThis.__LOREPACK_CAMPAIGN_COVERAGE__)}));
console.log(JSON.stringify(result));
} finally {if(retained)writeFileSync(tampered,retained);companion?.restore();capture.restore();}`,
      );
      const counters = join(root, `generated-graph-${mode}-counters.jsonl`);
      const fd = openSync(counters, 'wx');
      let output: string;
      try {
        if (mode !== 'clean' && mode !== 'dual') {
          const { default: processes } = await import('node:child_process');
          const failed = processes.spawnSync(process.execPath, [parent], {
            encoding: 'utf8',
            env: {},
            stdio: ['ignore', 'pipe', 'pipe', 'ignore', fd],
          });
          expect(failed.status).toBe(1);
          expect(failed.stdout).toBe('');
          expect(failed.stderr).toContain(
            ['changed-source', 'changed-input', 'changed-preparation'].includes(mode)
              ? 'Generated capture input changed before load'
              : 'Generated capture artifact changed before load',
          );
          return;
        }
        output = execFileSync(process.execPath, [parent], {
          encoding: 'utf8',
          env: {},
          stdio: ['ignore', 'pipe', 'pipe', 'ignore', fd],
        });
      } finally {
        closeSync(fd);
      }
      if (mode === 'dual') {
        const observed = JSON.parse(readFileSync(observation, 'utf8'));
        expect(typeof observed.external).toBe('boolean');
        expect(observed.maps).not.toContain(join(root, 'private.ts'));
        if (!observed.external) {
          expect(observed.descriptor).toBeGreaterThan(4);
          const companion = await replayCounterStream(
            snapshot,
            readFileSync(companionCounters, 'utf8'),
          );
          expect(companion.state).toBe('completed');
          expect(companion.maps).toEqual({});
        }
      }
      expect(JSON.parse(output)).toEqual([
        [2, 'yes'],
        [2, 'no'],
      ]);
      const replay = await replayCounterStream(snapshot, readFileSync(counters, 'utf8'));
      expect(replay.state).toBe('completed');
      const { actualMap } = await remapCounters(readFileSync(counters, 'utf8'));
      const actual = actualMap as unknown as Coverage;
      expect(actual).toBeDefined();
      for (const field of ['statementMap', 'fnMap', 'branchMap', 's', 'f', 'b'])
        expect(actual[field as keyof Coverage]).toEqual(
          maps[join(root, 'private.ts')]?.[field as keyof Coverage],
        );
      expect(Object.values(actual.f)).toContain(0);
    },
  );

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
