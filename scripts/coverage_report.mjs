import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { coverageInventory, readFrozenInventory } from './coverage_inventory.mjs';

const require = createRequire(import.meta.url);
const providerRequire = createRequire(require.resolve('@vitest/coverage-v8'));
const { createCoverageMap, createCoverageSummary } = providerRequire('istanbul-lib-coverage');
const TARGETS = {
  overall: { lines: 95, statements: 95, functions: 95, branches: 90 },
  critical: { lines: 98, statements: 98, functions: 95, branches: 95 },
};

function validateCounters(map) {
  for (const [counts, locations] of [
    ['s', 'statementMap'],
    ['f', 'fnMap'],
    ['b', 'branchMap'],
  ]) {
    if (
      !map[counts] ||
      !map[locations] ||
      !isDeepStrictEqual(Object.keys(map[counts]).sort(), Object.keys(map[locations]).sort())
    )
      throw new Error(`Invalid coverage counter IDs: ${map.path}`);
    for (const [id, value] of Object.entries(map[counts])) {
      const hits = counts === 'b' ? value : [value];
      if (
        !Array.isArray(hits) ||
        hits.some((hit) => !Number.isSafeInteger(hit) || hit < 0) ||
        (counts === 'b' && hits.length !== map[locations][id].locations.length)
      )
        throw new Error(`Invalid coverage counters: ${map.path}.${counts}.${id}`);
    }
  }
}

export function captureCoverage(snapshot, maps, origin) {
  if (!snapshot.root || !origin) throw new Error('Capture requires an inventory root and origin.');
  const root = realpathSync(snapshot.root);
  const sources = new Map(snapshot.included.map((entry) => [entry.path, entry.sha256]));
  const files = {};
  for (const [absolute, map] of Object.entries(maps)) {
    if (absolute !== map.path) throw new Error(`Coverage path differs from map key: ${absolute}`);
    const path = relative(root, realpathSync(absolute)).split('\\').join('/');
    if (!sources.has(path)) throw new Error(`Unexpected coverage source: ${path}`);
    if (Object.hasOwn(files, path)) throw new Error(`Duplicate coverage source: ${path}`);
    validateCounters(map);
    files[path] = { sha256: sources.get(path), map: { ...structuredClone(map), path } };
  }
  return {
    schemaVersion: 1,
    origin,
    candidate: snapshot.candidate ?? null,
    dirty: snapshot.dirty ?? null,
    files,
  };
}

export function reportCoverage(inventory, bundles) {
  const owned = new Map(inventory.included.map((entry) => [entry.path, entry]));
  if (!owned.size || owned.size !== inventory.included.length)
    throw new Error('Invalid owned inventory: sources must be nonempty and unique.');
  const canonical = new Map();
  const origins = [];
  for (const bundle of bundles) {
    if (bundle.schemaVersion !== 1 || typeof bundle.origin !== 'string' || !bundle.files)
      throw new Error('Invalid coverage bundle.');
    origins.push({
      origin: bundle.origin,
      candidate: bundle.candidate,
      dirty: bundle.dirty ?? null,
    });
    for (const [path, record] of Object.entries(bundle.files)) {
      const source = owned.get(path);
      if (!source) throw new Error(`Unexpected coverage source: ${path}`);
      if (record.sha256 !== source.sha256) throw new Error(`Stale coverage source: ${path}`);
      if (record.map.path !== path)
        throw new Error(`Coverage path differs from bundle key: ${path}`);
      validateCounters(record.map);
      const previous = canonical.get(path);
      if (previous) {
        for (const field of ['statementMap', 'fnMap', 'branchMap'])
          if (!isDeepStrictEqual(previous[field], record.map[field]))
            throw new Error(`Incompatible coverage ${field}: ${path}`);
        const merged = createCoverageMap({ [path]: previous });
        merged.merge({ [path]: structuredClone(record.map) });
        canonical.set(path, merged.fileCoverageFor(path).toJSON());
      } else canonical.set(path, structuredClone(record.map));
    }
  }
  const missing = [...owned.keys()].filter((path) => !canonical.has(path)).sort();
  const base = {
    ownedFiles: owned.size,
    criticalFiles: inventory.included.filter((entry) => entry.critical).length,
    representedFiles: canonical.size,
    missing,
    origins,
    targets: structuredClone(TARGETS),
  };
  if (missing.length)
    return {
      ...base,
      overall: null,
      critical: null,
      groups: null,
      failures: ['Owned sources are missing coverage; aggregate metrics are unavailable.'],
      status: 'Fail',
    };
  const overall = createCoverageSummary();
  const critical = createCoverageSummary();
  const groups = new Map();
  for (const [path, entry] of owned) {
    const summary = createCoverageMap({ [path]: canonical.get(path) }).getCoverageSummary();
    overall.merge(summary);
    if (entry.critical) critical.merge(summary);
    if (!groups.has(entry.group)) groups.set(entry.group, createCoverageSummary());
    groups.get(entry.group).merge(summary);
  }
  const metrics = { overall: overall.toJSON(), critical: critical.toJSON() };
  const failures = [];
  for (const [scope, targets] of Object.entries(TARGETS))
    for (const [metric, target] of Object.entries(targets))
      if (!Number.isFinite(metrics[scope][metric].pct) || metrics[scope][metric].pct < target)
        failures.push(`${scope}.${metric}: ${metrics[scope][metric].pct} < ${target}`);
  return {
    ...base,
    ...metrics,
    groups: Object.fromEntries([...groups].map(([group, value]) => [group, value.toJSON()])),
    failures,
    status: failures.length ? 'Fail' : 'Pass',
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        capture: { type: 'string' },
        map: { type: 'string' },
        origin: { type: 'string' },
        input: { type: 'string', multiple: true },
        out: { type: 'string' },
      },
    });
    const root = realpathSync(join(import.meta.dirname, '..'));
    const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
    let result;
    if (values.capture && values.map && values.origin && !values.input) {
      result = captureCoverage(readJson(values.capture), readJson(values.map), values.origin);
    } else if (values.input?.length && !values.capture && !values.map && !values.origin) {
      const inventory = coverageInventory(
        root,
        readFrozenInventory(join(root, 'tools/coverage_inventory/frozen_inventory.json')),
      );
      result = reportCoverage(inventory, values.input.map(readJson));
    } else
      throw new Error(
        'Use --capture <inventory> --map <coverage> --origin <label>, or --input <bundle> (repeatable), with --out <file>.',
      );
    if (!values.out) throw new Error('Coverage output requires --out <file>.');
    const output = resolve(root, values.out);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'Fail') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
