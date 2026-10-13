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
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertNativeCoverage } from '../../../scripts/coverage_native.mjs';

type Script = {
  scriptId: string;
  url: string;
  functions: {
    functionName: string;
    ranges: { startOffset: number; endOffset: number; count: number }[];
    isBlockCoverage: boolean;
  }[];
};
type RecordData = { origin: string; result: Script[] };
let directory: string;
let records: RecordData[];
let snapshot: { root: string; included: { path: string; sha256: string }[] };
const path = 'vitest.config.ts';
const code =
  "function defineConfig(value) { return value; }\nexport function unused() { return 42; }\nconst selected = process.argv[2] === 'yes' ? 1 : 2;\nexport default defineConfig({ selected });\n";

beforeAll(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'lorepack-native-coverage-')));
  writeFileSync(join(directory, path), code);
  snapshot = {
    root: directory,
    included: [{ path, sha256: createHash('sha256').update(code).digest('hex') }],
  };
  records = ['yes', 'no'].map((flag) => {
    const raw = join(directory, flag);
    execFileSync(process.execPath, [join(directory, path), flag], {
      env: { NODE_V8_COVERAGE: raw },
      stdio: 'pipe',
    });
    return {
      origin: flag,
      result: JSON.parse(readFileSync(join(raw, readdirSync(raw)[0] ?? 'missing.json'), 'utf8'))
        .result,
    };
  });
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('genuine native configuration coverage', () => {
  it.each([
    { defaultParameter: false, behavior: 'aligns exact source locations' },
    { defaultParameter: true, behavior: 'rejects unrecoverable default-parameter coverage' },
  ])('$behavior with actual Istanbul and native execution', async ({ defaultParameter }) => {
    const repository = resolve(import.meta.dirname, '../../..');
    const require = createRequire(join(repository, 'package.json'));
    const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
    mkdirSync(join(repository, 'coverage'), { recursive: true });
    const root = realpathSync(mkdtempSync(join(repository, 'coverage/native-layout-')));
    try {
      const path = 'witness.mjs';
      const source = join(root, path);
      const code = `export function choose(flag${defaultParameter ? ' = false' : ''}) {
  if (flag) return 1;
  return 2;
}
export function unused() { return 0; }
export const outputs = [choose(true), choose(${defaultParameter ? '' : 'false'})];
`;
      writeFileSync(source, code);
      writeFileSync(
        join(root, 'witness.test.mjs'),
        `import { expect, test } from 'vitest';
import { outputs } from './witness.mjs';
test('executes both arms', () => expect(outputs).toEqual([1, 2]));
`,
      );
      const config = join(root, 'vitest.config.mjs');
      writeFileSync(
        config,
        `export default ${JSON.stringify({
          root,
          test: {
            include: ['witness.test.mjs'],
            coverage: {
              provider: 'istanbul',
              enabled: true,
              include: ['witness.mjs'],
              exclude: [],
              reporter: ['json'],
              reportsDirectory: 'direct',
            },
          },
        })};\n`,
      );
      execFileSync(process.execPath, [vitest, 'run', '--config', config], {
        cwd: root,
        stdio: 'pipe',
      });
      const rawDirect = JSON.parse(readFileSync(join(root, 'direct/coverage-final.json'), 'utf8'));
      const direct = Object.fromEntries(
        Object.entries(rawDirect).map(([path, map]) => [realpathSync(path), map]),
      ) as typeof rawDirect;
      const raw = join(root, 'native');
      execFileSync(process.execPath, [source], { env: { NODE_V8_COVERAGE: raw }, stdio: 'pipe' });
      const records = readdirSync(raw).map((file) => ({
        origin: file,
        result: JSON.parse(readFileSync(join(raw, file), 'utf8')).result,
      }));
      const retained = structuredClone({ direct, records });
      const measured = await convertNativeCoverage(
        { root, included: [{ path, sha256: createHash('sha256').update(code).digest('hex') }] },
        records,
        direct,
      );
      if (defaultParameter) {
        const branch = Object.entries(direct[source].branchMap).find(
          ([, entry]) => (entry as { type: string }).type === 'default-arg',
        );
        if (!branch) throw new Error('Missing default-parameter witness.');
        expect(direct[source].b[branch[0]]).toEqual([1]);
        const choose = records
          .flatMap((record) => record.result)
          .flatMap((script: Script) => script.functions)
          .find((fn: Script['functions'][number]) => fn.functionName === 'choose');
        expect(choose?.ranges[0]?.count).toBe(2);
        expect(measured.maps).toEqual({});
        expect(measured.acceptedExecutions).toBe(0);
        expect(measured.rejected).toEqual([
          expect.objectContaining({
            path,
            reason: 'V8 default-parameter execution is not recoverable.',
          }),
        ]);
        expect({ direct, records }).toEqual(retained);
        return;
      }
      expect(measured.rejected).toEqual([]);
      expect(measured.acceptedExecutions).toBe(1);
      const map = measured.maps[source];
      for (const field of ['statementMap', 'fnMap', 'branchMap'])
        expect(map[field]).toEqual(direct[source][field]);
      expect(map.s).toEqual(direct[source].s);
      expect(map.b).toEqual(direct[source].b);
      const functions = Object.entries(map.fnMap).map(([id, entry]) => ({
        name: (entry as { name: string }).name,
        hits: map.f[id],
      }));
      expect(functions).toEqual(
        expect.arrayContaining([
          { name: 'choose', hits: 2 },
          { name: 'unused', hits: 0 },
        ]),
      );
      expect({ direct, records }).toEqual(retained);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('imports capture tooling from stdin without invoking CLI entrypoints', () => {
    const script = pathToFileURL(
      resolve(import.meta.dirname, '../../../scripts/coverage_native.mjs'),
    ).href;
    expect(
      execFileSync(process.execPath, ['--input-type=module', '-'], {
        input: `await import(${JSON.stringify(script)}); console.log('imported');`,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ).toBe('imported\n');
  });
  it('captures the default-export call without covering unused functions', async () => {
    const measured = await convertNativeCoverage(snapshot, records.slice(0, 1));
    expect(measured.acceptedExecutions).toBe(1);
    expect(measured.rejected).toEqual([]);
    const map = measured.maps[join(directory, path)];
    expect(map).toBeDefined();
    expect(Object.values(map.s)).toContain(0);
    expect(Object.values(map.f)).toContain(0);
    expect(Object.values(map.b).flat()).toContain(0);
    expect(
      Object.values(map.statementMap).some(
        (range) => (range as { start: { line: number } }).start.line === 4,
      ),
    ).toBe(true);
  });

  it('combines real branch executions and preserves the original raw records', async () => {
    const retained = structuredClone(records);
    const measured = await convertNativeCoverage(snapshot, records);
    expect(measured.acceptedExecutions).toBe(2);
    expect(measured.rejected).toEqual([]);
    const map = measured.maps[join(directory, path)];
    expect(
      Object.values(map.b)
        .flat()
        .every((count) => Number(count) > 0),
    ).toBe(true);
    expect(Object.values(map.f)).toContain(0);
    expect(records).toEqual(retained);
  });

  it('consumes genuine records from an asynchronous stream', async () => {
    async function* streamedRecords() {
      for (const record of records) yield record;
    }
    const expected = await convertNativeCoverage(snapshot, records);
    const measured = await convertNativeCoverage(snapshot, streamedRecords());
    expect(measured).toEqual(expected);
    expect(measured.acceptedExecutions).toBe(2);
    expect(Object.values(measured.maps[join(directory, path)].f)).toContain(0);
  });

  it('refuses source bytes changed after the inventory was captured', async () => {
    const stale = structuredClone(snapshot);
    const entry = stale.included[0];
    if (!entry) throw new Error('Missing witness source.');
    entry.sha256 = '0'.repeat(64);
    await expect(convertNativeCoverage(stale, records)).rejects.toThrow(
      'Stale native coverage source',
    );
  });

  it('rejects incompatible direct instrumentation without merging it', async () => {
    const native = await convertNativeCoverage(snapshot, records.slice(0, 1));
    const incompatible = structuredClone(native.maps);
    const map = incompatible[join(directory, path)];
    map.statementMap = {};
    const measured = await convertNativeCoverage(snapshot, records, incompatible);
    expect(measured.maps).toEqual({});
    expect(measured.acceptedExecutions).toBe(0);
    expect(measured.rejected).toHaveLength(2);
    expect(measured.rejected.every((record) => record.mismatch?.includes('statementMap'))).toBe(
      true,
    );
    expect(incompatible[join(directory, path)].statementMap).toEqual({});
  });

  it('rejects ambiguous counter locations without changing either input', async () => {
    const native = await convertNativeCoverage(snapshot, records.slice(0, 1));
    const direct = structuredClone(native.maps);
    const map = direct[join(directory, path)];
    const ids = Object.keys(map.statementMap);
    if (!ids[0] || !ids[1]) throw new Error('Missing statement witnesses.');
    map.statementMap[ids[1]] = structuredClone(map.statementMap[ids[0]]);
    const retained = structuredClone(direct);
    const measured = await convertNativeCoverage(snapshot, records, direct);
    expect(measured.acceptedExecutions).toBe(0);
    expect(measured.maps).toEqual({});
    expect(measured.rejected).toHaveLength(2);
    expect(measured.rejected.every((entry) => entry.mismatch?.includes('statementMap'))).toBe(true);
    expect(direct).toEqual(retained);
  });

  it('rejects line metadata that disagrees with the retained function location', async () => {
    const native = await convertNativeCoverage(snapshot, records.slice(0, 1));
    const direct = structuredClone(native.maps);
    const map = direct[join(directory, path)];
    const fn = Object.values(map.fnMap)[0] as { line: number; loc: { start: { line: number } } };
    fn.line = fn.loc.start.line + 1;
    const measured = await convertNativeCoverage(snapshot, records, direct);
    expect(measured.acceptedExecutions).toBe(0);
    expect(measured.maps).toEqual({});
    expect(measured.rejected.every((entry) => entry.mismatch?.includes('fnMap'))).toBe(true);
  });

  it('rejects reordered branch arms rather than moving their hit counts', async () => {
    const native = await convertNativeCoverage(snapshot, records.slice(0, 1));
    const direct = structuredClone(native.maps);
    const map = direct[join(directory, path)];
    const branch = Object.values(map.branchMap).find(
      (entry) => (entry as { locations: unknown[] }).locations.length === 2,
    ) as { locations: unknown[] } | undefined;
    if (!branch) throw new Error('Missing branch witness.');
    branch.locations.reverse();
    const measured = await convertNativeCoverage(snapshot, records, direct);
    expect(measured.acceptedExecutions).toBe(0);
    expect(measured.maps).toEqual({});
    expect(measured.rejected.every((entry) => entry.mismatch?.includes('branchMap'))).toBe(true);
  });

  it('combines compatible native counters without modifying the direct maps', async () => {
    const native = await convertNativeCoverage(snapshot, records.slice(0, 1));
    const retained = structuredClone(native.maps);
    const measured = await convertNativeCoverage(snapshot, records.slice(1), native.maps);
    expect(measured.acceptedExecutions).toBe(1);
    expect(measured.rejected).toEqual([]);
    expect(native.maps).toEqual(retained);
  });

  it('does not claim unvalidated TypeScript execution layouts', async () => {
    const other = { root: directory, included: [{ path: 'product.ts', sha256: 'unvalidated' }] };
    const scripts = records
      .flatMap((record) => record.result)
      .filter((script) => script.url.endsWith('/vitest.config.ts'));
    const changed = scripts.map((script) => ({
      ...script,
      url: script.url.replace('vitest.config.ts', 'product.ts'),
    }));
    const measured = await convertNativeCoverage(other, [
      { origin: 'unvalidated', result: changed },
    ]);
    expect(measured.maps).toEqual({});
    expect(measured.rejected).toHaveLength(2);
  });

  it('converts actual JavaScript subprocess execution', async () => {
    const script = 'witness.mjs';
    writeFileSync(join(directory, script), code);
    const raw = join(directory, 'javascript');
    execFileSync(process.execPath, [join(directory, script), 'yes'], {
      env: { NODE_V8_COVERAGE: raw },
      stdio: 'pipe',
    });
    const record = JSON.parse(
      readFileSync(join(raw, readdirSync(raw)[0] ?? 'missing.json'), 'utf8'),
    );
    const measured = await convertNativeCoverage(
      {
        root: directory,
        included: [{ path: script, sha256: createHash('sha256').update(code).digest('hex') }],
      },
      [{ origin: 'javascript', result: record.result }],
    );
    expect(measured.acceptedExecutions).toBe(1);
    expect(measured.rejected).toEqual([]);
    expect(Object.values(measured.maps[join(directory, script)].f)).toContain(0);
  });

  it('preserves original positions in a genuinely type-stripped configuration', async () => {
    const script = 'vite.config.ts';
    const typed = `function defineConfig(value: { selected: number }): { selected: number } { return value; }
export function unused(): number { return 42; }
const selected: number = process.argv[2] === 'yes' ? 1 : 2;
export default defineConfig({ selected });
`;
    writeFileSync(join(directory, script), typed);
    const raw = join(directory, 'typed');
    execFileSync(process.execPath, [join(directory, script), 'yes'], {
      env: { NODE_V8_COVERAGE: raw },
      stdio: 'pipe',
    });
    const record = JSON.parse(
      readFileSync(join(raw, readdirSync(raw)[0] ?? 'missing.json'), 'utf8'),
    );
    const measured = await convertNativeCoverage(
      {
        root: directory,
        included: [{ path: script, sha256: createHash('sha256').update(typed).digest('hex') }],
      },
      [{ origin: 'typed', result: record.result }],
    );
    expect(measured.acceptedExecutions).toBe(1);
    expect(measured.rejected).toEqual([]);
    const map = measured.maps[join(directory, script)];
    expect(Object.values(map.f)).toContain(0);
    expect(Object.values(map.b).flat()).toContain(0);
  });

  it('rejects transformed execution under an original source filename', async () => {
    const script = 'transformed.mjs';
    const original = 'function used() { return 42; }\nused();\n';
    writeFileSync(join(directory, script), original);
    const raw = join(directory, 'transformed');
    const filename = pathToFileURL(join(directory, script)).href;
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
const filename = ${JSON.stringify(filename)};
runInThisContext('0;\\n' + readFileSync(new URL(filename), 'utf8'), { filename });`,
      ],
      { env: { NODE_V8_COVERAGE: raw }, stdio: 'pipe' },
    );
    const record = JSON.parse(
      readFileSync(join(raw, readdirSync(raw)[0] ?? 'missing.json'), 'utf8'),
    );
    const measured = await convertNativeCoverage(
      {
        root: directory,
        included: [{ path: script, sha256: createHash('sha256').update(original).digest('hex') }],
      },
      [{ origin: 'transformed', result: record.result }],
    );
    expect(measured.acceptedExecutions).toBe(0);
    expect(measured.maps).toEqual({});
    expect(measured.rejected).toEqual([
      expect.objectContaining({
        origin: 'transformed',
        path: script,
        reason: 'Native execution offsets do not match the owned source.',
      }),
    ]);
  });

  it('writes a source-bound bundle through the actual command', () => {
    const inventory = join(directory, 'inventory.json');
    const output = join(directory, 'nested/bundle.json');
    writeFileSync(inventory, JSON.stringify(snapshot));
    execFileSync(
      process.execPath,
      [
        resolve(import.meta.dirname, '../../../scripts/coverage_native.mjs'),
        '--inventory',
        inventory,
        '--raw',
        join(directory, 'yes'),
        '--origin',
        'native-fixture',
        '--out',
        output,
      ],
      { stdio: 'pipe' },
    );
    const bundle = JSON.parse(readFileSync(output, 'utf8'));
    expect(bundle.origin).toBe('native-fixture');
    expect(bundle.files[path].sha256).toBe(createHash('sha256').update(code).digest('hex'));
    expect(bundle.files[path].map.path).toBe(path);
    expect(bundle.nativeEvidence).toEqual({ acceptedExecutions: 1, rejected: [] });
    expect(Object.values(bundle.files[path].map.f)).toContain(0);
  });
});
