import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
