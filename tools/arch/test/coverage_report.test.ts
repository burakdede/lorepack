import { execFileSync, spawnSync } from 'node:child_process';
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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertNativeCoverage } from '../../../scripts/coverage_native.mjs';
import { captureCoverage, reportCoverage } from '../../../scripts/coverage_report.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const require = createRequire(join(ROOT, 'package.json'));
const providerRequire = createRequire(require.resolve('@vitest/coverage-v8'));
const { convert } = await import(pathToFileURL(providerRequire.resolve('ast-v8-to-istanbul')).href);
const { parseAstAsync } = await import(pathToFileURL(require.resolve('vitest/node')).href);
type Range = {
  start: { line: number; column: number };
  end: { line: number; column: number };
  marker?: string;
};
type MapData = {
  path: string;
  statementMap: Record<string, Range>;
  fnMap: Record<string, { name: string; decl: Range; loc: Range; marker?: string }>;
  branchMap: Record<
    string,
    { type: string; loc: Range; line: number; locations: Range[]; marker?: string }
  >;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
};
type Snapshot = {
  root: string;
  candidate: string;
  included: { path: string; sha256: string; critical: boolean; group: string }[];
};
type Bundle = {
  schemaVersion: number;
  origin: string;
  candidate: string | null;
  files: Record<string, { sha256: string; map: MapData }>;
};
function sourceMap(bundle: Bundle): MapData {
  const file = bundle.files[path];
  if (!file) throw new Error('Witness source is missing.');
  return file.map;
}
let directory: string;
let snapshot: Snapshot;
let negative: Bundle;
let yes: Bundle;
let no: Bundle;
const path = 'packages/core/src/sql/witness.mjs';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'lorepack-coverage-report-'));
  const source = join(directory, path);
  mkdirSync(join(directory, 'packages/core/src/sql'), { recursive: true });
  const code =
    "export function unused() { return 42; }\nconst flag = process.argv[2];\nif (flag === 'yes') unused();\nconst branch = flag === 'yes' ? 1 : 2;\n";
  writeFileSync(source, code);
  snapshot = {
    root: directory,
    candidate: 'native-fixture',
    included: [
      {
        path,
        sha256: createHash('sha256').update(code).digest('hex'),
        critical: true,
        group: 'core',
      },
    ],
  };
  for (const flag of ['negative', 'yes', 'no']) {
    const rawDirectory = join(directory, flag);
    mkdirSync(rawDirectory);
    execFileSync(process.execPath, [source, flag], {
      env: { NODE_V8_COVERAGE: rawDirectory },
      stdio: 'pipe',
    });
    const raw = JSON.parse(
      readFileSync(
        join(
          rawDirectory,
          readdirSync(rawDirectory).find((file) => file.endsWith('.json')) ?? 'missing.json',
        ),
        'utf8',
      ),
    );
    const coverage = raw.result.find((entry: { url: string }) => entry.url.endsWith(`/${path}`));
    if (!coverage) throw new Error('Native witness coverage is missing.');
    const maps = await convert({
      code,
      ast: await parseAstAsync(code),
      coverage,
      wrapperLength: 0,
    });
    const bundle = captureCoverage(snapshot, maps, flag) as Bundle;
    if (flag === 'negative') negative = bundle;
    else if (flag === 'yes') yes = bundle;
    else no = bundle;
  }
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const copy = <T>(value: T): T => structuredClone(value);
describe('owned coverage report', () => {
  it('fails qualification when another execution of a represented source is rejected', async () => {
    const root = realpathSync(directory);
    const path = 'rejected-witness.mjs';
    const code = 'function used() { return 42; }\nused();\n';
    const source = join(root, path);
    writeFileSync(source, code);
    const inventory = {
      root,
      included: [
        {
          path,
          sha256: createHash('sha256').update(code).digest('hex'),
          critical: true,
          group: 'witness',
        },
      ],
    };
    const records = [];
    for (const origin of ['original', 'wrapped']) {
      const raw = join(root, `report-${origin}`);
      mkdirSync(raw);
      const filename = pathToFileURL(source).href;
      const args =
        origin === 'original'
          ? [source]
          : [
              '--input-type=module',
              '-e',
              `import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
const filename = ${JSON.stringify(filename)};
runInThisContext('0;\\n' + readFileSync(new URL(filename), 'utf8'), { filename });`,
            ];
      execFileSync(process.execPath, args, { env: { NODE_V8_COVERAGE: raw }, stdio: 'pipe' });
      for (const file of readdirSync(raw)) {
        records.push({ origin, result: JSON.parse(readFileSync(join(raw, file), 'utf8')).result });
      }
    }
    const measured = await convertNativeCoverage(inventory, records);
    expect(measured.acceptedExecutions).toBe(1);
    expect(measured.rejected).toEqual([
      expect.objectContaining({
        origin: 'wrapped',
        path,
        reason: 'Native execution offsets do not match the owned source.',
      }),
    ]);
    const bundle = {
      ...captureCoverage(inventory, measured.maps, 'native-witness'),
      nativeEvidence: {
        acceptedExecutions: measured.acceptedExecutions,
        rejected: measured.rejected,
      },
    };
    const report = reportCoverage(inventory, [bundle]);
    expect(report.status).toBe('Fail');
    expect(report.ownedFiles).toBe(1);
    expect(report.representedFiles).toBe(1);
    expect(report.overall).toBeNull();
    expect(report.critical).toBeNull();
    expect(report.rejectedExecutions).toEqual([
      { bundleOrigin: 'native-witness', ...measured.rejected[0] },
    ]);
  });
  it('preserves the real unexecuted function and branch in its negative witness', () => {
    const report = reportCoverage(snapshot, [negative]);
    expect(report.status).toBe('Fail');
    expect(report.critical.functions.covered).toBe(0);
    expect(report.critical.functions.total).toBe(1);
    expect(report.critical.branches.pct).toBeLessThan(95);
    expect(report.failures).toContain('critical.functions: 0 < 95');
  });
  it('merges compatible real native executions without changing denominators', () => {
    const before = reportCoverage(snapshot, [negative]);
    const report = reportCoverage(snapshot, [negative, yes, no]);
    expect(report.status).toBe('Pass');
    expect(report.critical.functions.total).toBe(before.critical.functions.total);
    expect(report.critical.branches.total).toBe(before.critical.branches.total);
    expect(report.critical.functions.pct).toBe(100);
    expect(report.critical.branches.pct).toBe(100);
  });
  it.each([
    null,
    { acceptedExecutions: -1, rejected: [] },
    { acceptedExecutions: 1, rejected: null },
  ])('refuses malformed native evidence: %j', (nativeEvidence) => {
    expect(() => reportCoverage(snapshot, [{ ...yes, nativeEvidence }, no])).toThrow(
      'Invalid native coverage evidence',
    );
  });
  it('refuses a rejected execution attributed to an unowned source', () => {
    const nativeEvidence = {
      acceptedExecutions: 1,
      rejected: [{ origin: 'child', path: 'unexpected.mjs', reason: 'Unsupported layout' }],
    };
    expect(() => reportCoverage(snapshot, [{ ...yes, nativeEvidence }, no])).toThrow(
      'Unexpected rejected coverage source: unexpected.mjs',
    );
  });
  it('does not publish a smaller aggregate when an owned source is missing', () => {
    const inventory = copy(snapshot);
    inventory.included.push({
      path: 'new.mjs',
      sha256: '0'.repeat(64),
      critical: false,
      group: 'new',
    });
    const report = reportCoverage(inventory, [yes, no]);
    expect(report.status).toBe('Fail');
    expect(report.missing).toEqual(['new.mjs']);
    expect(report.overall).toBeNull();
    expect(report.critical).toBeNull();
    expect(report.groups).toBeNull();
  });
  it('does not modify its captured input evidence when merging', () => {
    const before = copy(negative);
    reportCoverage(snapshot, [negative, yes, no]);
    expect(negative).toEqual(before);
  });
  it('does not let a returned report change subsequent thresholds', () => {
    const report = reportCoverage(snapshot, [negative]);
    report.targets.critical.functions = 0;
    expect(reportCoverage(snapshot, [negative]).failures).toContain('critical.functions: 0 < 95');
  });
  it('refuses empty and duplicate ownership inventories', () => {
    expect(() => reportCoverage({ included: [] }, [])).toThrow('Invalid owned inventory');
    expect(() =>
      reportCoverage({ included: [...snapshot.included, ...snapshot.included] }, []),
    ).toThrow('Invalid owned inventory');
  });
  it('refuses unknown sources, mismatched keys and duplicate physical paths during capture', () => {
    const absolute = join(snapshot.root, path);
    const map = { ...sourceMap(negative), path: absolute };
    expect(() =>
      captureCoverage(snapshot, { [absolute]: { ...map, path: 'different' } }, 'bad'),
    ).toThrow('Coverage path differs');
    expect(() =>
      captureCoverage({ ...snapshot, included: [] }, { [absolute]: map }, 'bad'),
    ).toThrow('Unexpected coverage source');
    const alias = `${dirname(absolute)}${sep}.${sep}witness.mjs`;
    expect(() =>
      captureCoverage(snapshot, { [absolute]: map, [alias]: { ...map, path: alias } }, 'duplicate'),
    ).toThrow('Duplicate coverage source');
  });
  it('refuses stale hashes', () => {
    const bundle = copy(yes);
    const record = bundle.files[path];
    if (!record) throw new Error('Missing witness.');
    record.sha256 = '0'.repeat(64);
    expect(() => reportCoverage(snapshot, [bundle])).toThrow('Stale coverage source');
  });
  it('refuses unexpected files and inconsistent map paths', () => {
    const bundle = copy(yes);
    const record = bundle.files[path];
    if (!record) throw new Error('Missing witness.');
    bundle.files['unexpected.mjs'] = record;
    expect(() => reportCoverage(snapshot, [bundle])).toThrow('Unexpected coverage source');
    delete bundle.files['unexpected.mjs'];
    sourceMap(bundle).path = 'different.mjs';
    expect(() => reportCoverage(snapshot, [bundle])).toThrow('Coverage path differs');
  });
  it.each(['statementMap', 'fnMap', 'branchMap'] as const)('rejects incompatible %s', (field) => {
    const bundle = copy(yes);
    const first = Object.values(sourceMap(bundle)[field])[0];
    if (!first) throw new Error('Witness counter location is missing.');
    first.marker = 'incompatible';
    expect(() => reportCoverage(snapshot, [negative, bundle])).toThrow('Incompatible coverage');
  });
  it('refuses reordered branch arms', () => {
    const bundle = copy(yes);
    const branch = Object.values(sourceMap(bundle).branchMap).find(
      (value) => value.locations.length > 1,
    );
    if (!branch) throw new Error('Witness branch is missing.');
    branch.locations.reverse();
    expect(() => reportCoverage(snapshot, [negative, bundle])).toThrow(
      'Incompatible coverage branchMap',
    );
  });
  it.each([-1, 0.5, NaN, Infinity])('refuses invalid hit count %s', (count) => {
    const bundle = copy(yes);
    sourceMap(bundle).s['0'] = count;
    expect(() => reportCoverage(snapshot, [bundle])).toThrow('Invalid coverage counters');
  });
  it('refuses missing counter IDs and malformed branch-arm counts', () => {
    const bundle = copy(yes);
    delete sourceMap(bundle).s['0'];
    expect(() => reportCoverage(snapshot, [bundle])).toThrow('Invalid coverage counter IDs');
    const other = copy(yes);
    const arms = sourceMap(other).b['0'];
    if (!arms) throw new Error('Witness branch counter is missing.');
    arms.push(1);
    expect(() => reportCoverage(snapshot, [other])).toThrow('Invalid coverage counters');
  });
  it('requires the bundle schema and snapshot binding', () => {
    expect(() => reportCoverage(snapshot, [{ ...yes, schemaVersion: 2 }])).toThrow(
      'Invalid coverage bundle',
    );
    expect(() => captureCoverage({ ...snapshot, root: null }, {}, 'missing')).toThrow(
      'inventory root',
    );
    expect(() => captureCoverage(snapshot, {}, '')).toThrow('inventory root');
  });
  it('captures actual native maps through the CLI with source-hash binding', () => {
    const absolute = join(snapshot.root, path);
    const snapshotFile = join(directory, 'native-snapshot.json');
    const mapFile = join(directory, 'native-map.json');
    const output = join(directory, 'native-bundle.json');
    writeFileSync(snapshotFile, JSON.stringify(snapshot));
    const maps = { [absolute]: { ...sourceMap(negative), path: absolute } };
    writeFileSync(mapFile, JSON.stringify(maps));
    execFileSync(
      process.execPath,
      [
        join(ROOT, 'scripts/coverage_report.mjs'),
        '--capture',
        snapshotFile,
        '--map',
        mapFile,
        '--origin',
        'real-native',
        '--out',
        output,
      ],
      { stdio: 'pipe' },
    );
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(
      captureCoverage(snapshot, JSON.parse(readFileSync(mapFile, 'utf8')), 'real-native'),
    );
  });
  it('writes a failing CLI report with null aggregates for missing coverage', () => {
    const currentSnapshot = join(directory, 'snapshot.json');
    const map = join(directory, 'empty.json');
    const bundle = join(directory, 'bundle.json');
    const report = join(directory, 'report.json');
    writeFileSync(currentSnapshot, JSON.stringify(snapshot));
    writeFileSync(map, '{}');
    execFileSync(
      process.execPath,
      [
        join(ROOT, 'scripts/coverage_report.mjs'),
        '--capture',
        currentSnapshot,
        '--map',
        map,
        '--origin',
        'empty',
        '--out',
        bundle,
      ],
      { stdio: 'pipe' },
    );
    const child = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/coverage_report.mjs'), '--input', bundle, '--out', report],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    expect(child.status, child.stderr).toBe(1);
    expect(existsSync(report), child.stderr || child.stdout).toBe(true);
    const result = JSON.parse(readFileSync(report, 'utf8'));
    expect(result.status).toBe('Fail');
    expect(result.overall).toBeNull();
    expect(result.missing).toContain('scripts/coverage_report.mjs');
    expect(result.ownedFiles).toBeGreaterThan(345);
  });
});
