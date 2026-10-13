import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureCampaign, nodeCommand } from '../../../scripts/coverage_capture.mjs';
import { preparingInstrumenter } from '../../../scripts/coverage_configuration.mjs';
import { prepareNativeCapture } from '../../../scripts/coverage_instrumented.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
let directory: string;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'lorepack-capture-driver-')));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function inventory() {
  const path = 'packages/core/vitest.config.ts';
  const code = "export default {test:{include:['test/*.test.ts']}};";
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, 'packages/core/package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(directory, path), code);
  const snapshot = join(directory, 'inventory.json');
  writeFileSync(
    snapshot,
    JSON.stringify({
      root: directory,
      included: [{ path, sha256: createHash('sha256').update(code).digest('hex') }],
    }),
  );
  return { path, snapshot };
}

describe('coverage campaign execution boundaries', () => {
  it('propagates the actual failed child exit', () => {
    try {
      nodeCommand(ROOT, ['-e', 'process.exit(7)']);
      throw new Error('Expected the child command to fail.');
    } catch (error) {
      expect(error).toMatchObject({ status: 7 });
    }
  });

  it('passes explicit capture environment to the actual child', () => {
    const marker = join(directory, 'environment.txt');
    nodeCommand(
      ROOT,
      [
        '-e',
        "require('node:fs').writeFileSync(process.argv[1],process.env.LOREPACK_CAPTURE_WITNESS)",
        marker,
      ],
      { LOREPACK_CAPTURE_WITNESS: 'capture-only' },
    );
    expect(readFileSync(marker, 'utf8')).toBe('capture-only');
    expect(process.env.LOREPACK_CAPTURE_WITNESS).toBeUndefined();
  });

  it('requires the actual pnpm script entrypoint', async () => {
    await expect(captureCampaign(ROOT, join(directory, 'output'), undefined)).rejects.toThrow(
      'pnpm coverage:capture',
    );
    expect(existsSync(join(directory, 'output'))).toBe(false);
  });

  it('refuses existing output rather than overwriting evidence', async () => {
    const output = join(directory, 'existing');
    mkdirSync(output);
    const retained = join(output, 'retained.json');
    writeFileSync(retained, '{"original":true}\n');
    await expect(captureCampaign(ROOT, output, 'unused')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(retained, 'utf8')).toBe('{"original":true}\n');
  });

  it('stops a campaign when its actual build child fails', async () => {
    const failedBuild = join(directory, 'failed-build.mjs');
    writeFileSync(failedBuild, 'process.exit(7);');
    const output = join(directory, 'build-failure');
    await expect(captureCampaign(ROOT, output, failedBuild)).rejects.toMatchObject({ status: 7 });
    expect(existsSync(join(output, 'inventory.json'))).toBe(false);
    expect(existsSync(join(output, 'report.json'))).toBe(false);
  });

  it('imports config through the actual CLI and captures genuine Node execution', () => {
    const { path, snapshot } = inventory();
    const results = join(directory, 'results.json');
    const raw = join(directory, 'raw-v8');
    execFileSync(
      process.execPath,
      [
        join(ROOT, 'scripts/coverage_capture.mjs'),
        '--import-configs',
        snapshot,
        '--results',
        results,
      ],
      {
        env: { ...process.env, NODE_V8_COVERAGE: raw },
        stdio: 'pipe',
      },
    );
    expect(JSON.parse(readFileSync(results, 'utf8'))).toEqual([
      { path, imported: true, configurationAssertions: 'passed' },
    ]);
    const records = readdirSync(raw)
      .filter((file) => file.startsWith('coverage-'))
      .flatMap((file) => JSON.parse(readFileSync(join(raw, file), 'utf8')).result);
    const script = records.find((entry: { url: string }) =>
      entry.url.endsWith('/packages/core/vitest.config.ts'),
    );
    expect(script).toBeDefined();
    expect(script.functions[0].ranges[0].count).toBeGreaterThan(0);
  });

  it('rejects a stale config in the real CLI without writing import results', () => {
    const { path, snapshot } = inventory();
    writeFileSync(join(directory, path), "throw new Error('Stale config executed.');");
    const results = join(directory, 'stale.results.json');
    expect(() =>
      execFileSync(
        process.execPath,
        [
          join(ROOT, 'scripts/coverage_capture.mjs'),
          '--import-configs',
          snapshot,
          '--results',
          results,
        ],
        { stdio: 'pipe' },
      ),
    ).toThrow('Stale configuration source');
    expect(existsSync(results)).toBe(false);
  });
});

async function nativeFixture(code = 'export const value = 7;') {
  const path = 'owned.mjs';
  const source = join(directory, path);
  writeFileSync(source, code);
  const snapshot = {
    root: directory,
    included: [{ path, sha256: createHash('sha256').update(code).digest('hex') }],
  };
  const preparations = join(directory, 'preparations');
  const factory = await preparingInstrumenter(snapshot, preparations);
  factory({ coverageVariable: '__preparation_witness__' }).instrumentSync(code, source);
  const nativePreparations = join(directory, 'native-preparations');
  await prepareNativeCapture(snapshot, preparations, nativePreparations);
  const output = join(directory, 'native');
  const bootstrap = join(directory, 'bootstrap.mjs');
  writeFileSync(
    bootstrap,
    `import {registerNativeCapture} from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/coverage_instrumented.mjs')).href)}; await registerNativeCapture(${JSON.stringify(snapshot)},${JSON.stringify(nativePreparations)},${JSON.stringify(output)});`,
  );
  const entry = join(directory, 'entry.mjs');
  writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(source).href)};`);
  const records = () =>
    readdirSync(output).map((file) => JSON.parse(readFileSync(join(output, file), 'utf8')));
  return { source, entry, bootstrap, output, records, preparations: nativePreparations };
}

describe('native instrumentation process capture', () => {
  it('captures genuine initializer, unused-function and branch counters once', async () => {
    const fixture =
      await nativeFixture(`function choose(flag = false) { if (flag) return 1; return 2; }
function unused() { return 9; }
choose(); choose(true);`);
    const result = spawnSync(process.execPath, ['--import', fixture.bootstrap, fixture.entry], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const records = fixture.records();
    expect(records).toHaveLength(2);
    const start = records.find((record) => record.state === 'started');
    const completed = records.find((record) => record.state === 'completed');
    expect(start.id).toBe(completed.id);
    expect(completed.exitCode).toBe(0);
    expect(completed.rejected).toEqual([]);
    expect(completed.loadedSources).toHaveLength(1);
    const map = completed.maps[fixture.source];
    expect(Object.values(map.f)).toEqual([2, 0]);
    expect(Object.values(map.b)).toEqual([[1], [1, 1]]);
    expect(readdirSync(fixture.output).some((file) => file.endsWith('.tmp'))).toBe(false);
  });

  it('preserves explicit and uncaught failure exit codes', async () => {
    const fixture = await nativeFixture();
    for (const [code, status] of [
      ['process.exit(7);', 7],
      ["throw new Error('Expected failure');", 1],
    ] as const) {
      writeFileSync(
        fixture.entry,
        `import ${JSON.stringify(pathToFileURL(fixture.source).href)}; ${code}`,
      );
      const plain = spawnSync(process.execPath, [fixture.entry], { encoding: 'utf8' });
      const captured = spawnSync(process.execPath, ['--import', fixture.bootstrap, fixture.entry], {
        encoding: 'utf8',
      });
      expect(plain.status).toBe(status);
      expect(captured.status, captured.stderr).toBe(status);
    }
    expect(
      fixture
        .records()
        .filter((record) => record.state === 'completed')
        .map((record) => record.exitCode)
        .sort(),
    ).toEqual([1, 7]);
  });

  it('records an explicit empty execution when no owned source loads', async () => {
    const fixture = await nativeFixture();
    writeFileSync(fixture.entry, 'process.exit(0);');
    const result = spawnSync(process.execPath, ['--import', fixture.bootstrap, fixture.entry], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const completed = fixture.records().find((record) => record.state === 'completed');
    expect(completed.maps).toEqual({});
    expect(completed.loadedSources).toEqual([]);
    expect(completed.rejected).toEqual([]);
  });

  it('retains rejection evidence for missing preparations and changed loaded source', async () => {
    const fixture = await nativeFixture();
    writeFileSync(fixture.source, 'export const changed = 8;');
    let result = spawnSync(process.execPath, ['--import', fixture.bootstrap, fixture.entry], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(
      fixture.records().find((record) => record.state === 'completed').rejected[0].reason,
    ).toContain('differs from inventory');
    writeFileSync(fixture.source, 'export const value = 7;');
    rmSync(fixture.preparations, { recursive: true });
    result = spawnSync(process.execPath, ['--import', fixture.bootstrap, fixture.entry], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(
      fixture
        .records()
        .filter((record) => record.state === 'completed')
        .every((record) => record.rejected.length === 1),
    ).toBe(true);
  });

  it('leaves a started record and no fabricated completion after termination', async () => {
    const fixture = await nativeFixture(
      "console.log('capture-ready'); setInterval(() => {},1000);",
    );
    const child = spawn(process.execPath, ['--import', fixture.bootstrap, fixture.entry], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Capture child exited before ready.')));
        child.stdout.on('data', (chunk) => {
          if (String(chunk).includes('capture-ready')) resolve();
        });
      });
      const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await stopped;
      expect(fixture.records().map((record) => record.state)).toEqual(['started']);
    } finally {
      child.kill();
    }
  });
});

it('preserves file-access denial under explicit identical Node permissions', async () => {
  const deniedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'lorepack-native-denied-')));
  try {
    const denied = join(deniedRoot, 'unreadable.txt');
    writeFileSync(denied, 'permission-witness');
    const fixture = await nativeFixture(
      `import {readFileSync} from 'node:fs'; readFileSync(${JSON.stringify(denied)});`,
    );
    const flags = [
      '--permission',
      `--allow-fs-read=${ROOT}`,
      `--allow-fs-read=${directory}`,
      `--allow-fs-write=${directory}`,
    ];
    const plain = spawnSync(process.execPath, [...flags, fixture.entry], { encoding: 'utf8' });
    const captured = spawnSync(
      process.execPath,
      [...flags, '--import', fixture.bootstrap, fixture.entry],
      { encoding: 'utf8' },
    );
    expect(plain.status).toBe(1);
    expect(plain.stderr).toContain('ERR_ACCESS_DENIED');
    expect(captured.status).toBe(plain.status);
    expect(captured.stderr).toContain('ERR_ACCESS_DENIED');
    expect(
      fixture.records().find((record) => record.state === 'completed').loadedSources,
    ).toHaveLength(1);
  } finally {
    rmSync(deniedRoot, { recursive: true, force: true });
  }
});

it('rejects duplicate registration without recording duplicate execution', async () => {
  const fixture = await nativeFixture();
  const bootstrap = readFileSync(fixture.bootstrap, 'utf8');
  writeFileSync(
    fixture.bootstrap,
    `${bootstrap}\n${bootstrap.slice(bootstrap.indexOf('await registerNativeCapture'))}`,
  );
  const result = spawnSync(process.execPath, ['--import', fixture.bootstrap, fixture.entry], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('already registered');
  expect(fixture.records().filter((record) => record.state === 'started')).toHaveLength(1);
  expect(fixture.records().filter((record) => record.state === 'completed')).toHaveLength(1);
});

it('rejects changed instrumented bytes before executing them', async () => {
  const fixture = await nativeFixture();
  const file = join(fixture.preparations, readdirSync(fixture.preparations)[0] ?? 'missing');
  const prepared = JSON.parse(readFileSync(file, 'utf8'));
  prepared.instrumentedCode = "throw new Error('Changed native code executed');";
  writeFileSync(file, JSON.stringify(prepared));
  const result = spawnSync(process.execPath, ['--import', fixture.bootstrap, fixture.entry], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain('Changed native code executed');
  expect(
    fixture.records().find((record) => record.state === 'completed').rejected[0].reason,
  ).toContain('instrumented preparation differs');
});

it('rejects query-qualified owned native execution', async () => {
  const fixture = await nativeFixture();
  writeFileSync(
    fixture.entry,
    `import ${JSON.stringify(`${pathToFileURL(fixture.source).href}?wrapped`)};`,
  );
  const result = spawnSync(process.execPath, ['--import', fixture.bootstrap, fixture.entry], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(
    fixture.records().find((record) => record.state === 'completed').rejected[0].reason,
  ).toContain('query or fragment');
});

it('keeps inherited worker executions distinct from the parent snapshot', async () => {
  const fixture = await nativeFixture('function used() { return 7; } used(); used();');
  writeFileSync(
    fixture.entry,
    `import {Worker} from 'node:worker_threads'; await Promise.all([1,2].map(() => new Promise((resolve,reject) => {const worker = new Worker(new URL(${JSON.stringify(pathToFileURL(fixture.source).href)})); worker.once('error',reject); worker.once('exit',code=>code===0?resolve():reject(new Error('Worker failed'))); })));`,
  );
  const result = spawnSync(process.execPath, ['--import', fixture.bootstrap, fixture.entry], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  const records = fixture.records();
  const completed = records.filter((record) => record.state === 'completed');
  expect(records.filter((record) => record.state === 'started')).toHaveLength(3);
  expect(completed).toHaveLength(3);
  expect(new Set(completed.map((record) => record.id)).size).toBe(3);
  expect(new Set(completed.map((record) => record.threadId)).size).toBe(3);
  expect(completed.find((record) => record.threadId === 0).maps).toEqual({});
  for (const record of completed.filter((record) => record.threadId !== 0))
    expect(Object.values(record.maps[fixture.source].f)).toEqual([2]);
});

it('records a delegated loader failure as rejected owned execution', async () => {
  const fixture = await nativeFixture();
  const bootstrap = readFileSync(fixture.bootstrap, 'utf8');
  writeFileSync(
    fixture.bootstrap,
    `import {registerHooks} from 'node:module'; registerHooks({load(url,context,nextLoad){if(url===${JSON.stringify(pathToFileURL(fixture.source).href)}) throw new Error('Delegated loader witness'); return nextLoad(url,context);}}); ${bootstrap}`,
  );
  const result = spawnSync(process.execPath, ['--import', fixture.bootstrap, fixture.entry], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  const completed = fixture.records().find((record) => record.state === 'completed');
  expect(completed.loadedSources).toEqual([]);
  expect(completed.maps).toEqual({});
  expect(completed.rejected).toEqual([{ path: 'owned.mjs', reason: 'Delegated loader witness' }]);
});
