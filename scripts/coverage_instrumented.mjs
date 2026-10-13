import { createHash, randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { threadId } from 'node:worker_threads';
import { prepareSource } from './coverage_configuration.mjs';

const active = Symbol.for('lorepack.nativeCoverageCollector');
const variable = '__LOREPACK_NATIVE_COVERAGE__';
const digest = (value) => createHash('sha256').update(value).digest('hex');

function publish(directory, name, value) {
  const filename = join(directory, name);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
  try {
    linkSync(temporary, filename);
  } finally {
    unlinkSync(temporary);
  }
}

export async function prepareNativeCapture(snapshot, preparations, directory) {
  const root = realpathSync(snapshot.root);
  const { createNativeInstrumenter } = await import('@vitest/coverage-istanbul/dist/provider.js');
  const instrumenter = createNativeInstrumenter({
    produceSourceMap: true,
    autoWrap: false,
    esModules: true,
    compact: false,
    coverageVariable: variable,
    coverageGlobalScope: 'globalThis',
    coverageGlobalScopeFunc: false,
    parserPlugins: [
      ...createNativeInstrumenter().opts.parserPlugins,
      ['importAttributes', { deprecatedAssertSyntax: true }],
    ],
    generatorOpts: { importAttributesKeyword: 'with' },
    ignoreLines: true,
  });
  mkdirSync(directory);
  for (const entry of snapshot.included) {
    const key = digest(entry.path);
    const prepared = JSON.parse(readFileSync(join(preparations, `${key}.json`), 'utf8'));
    const expected = prepareSource(snapshot, join(root, entry.path), prepared.code, prepared.map);
    for (const field of ['schema', 'kind', 'provider', 'path', 'sha256'])
      if (prepared[field] !== expected[field])
        throw new Error(`Native preparation identity differs: ${entry.path}`);
    const instrumentedCode = instrumenter.instrumentSync(
      prepared.code,
      join(root, entry.path),
      prepared.map ?? undefined,
    );
    publish(directory, `${key}.json`, {
      ...prepared,
      instrumentedCode,
      instrumentedSha256: digest(instrumentedCode),
      coverageVariable: variable,
    });
  }
}

export async function registerNativeCapture(snapshot, preparations, directory) {
  if (globalThis[active] || Object.hasOwn(globalThis, variable))
    throw new Error('Native coverage collector already registered or counters already exist.');
  const root = realpathSync(snapshot.root);
  const owned = new Map(snapshot.included.map((entry) => [join(root, entry.path), entry]));
  const id = randomUUID();
  mkdirSync(directory, { recursive: true });
  const identity = { schema: 1, id, pid: process.pid, threadId, provider: 'istanbul@4.1.11' };
  publish(directory, `${id}.started.json`, { ...identity, state: 'started' });
  const loadedSources = [];
  const rejected = [];
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      const address = new URL(url);
      const filename = fileURLToPath(address);
      const entry = owned.get(filename);
      if (!entry) return nextLoad(url, context);
      try {
        const loaded = nextLoad(url, context);
        if (address.search || address.hash)
          throw new Error('Owned native module has query or fragment.');
        if (!['module', 'module-typescript'].includes(loaded.format))
          throw new Error(`Unsupported owned native format: ${loaded.format}`);
        if (loaded.source == null)
          throw new Error('Owned native source was not supplied by loader.');
        const bytes = Buffer.from(loaded.source);
        if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
          throw new Error('Loaded native source differs from inventory.');
        const key = createHash('sha256').update(entry.path).digest('hex');
        const prepared = JSON.parse(readFileSync(join(preparations, `${key}.json`), 'utf8'));
        if (
          prepared.schema !== 1 ||
          prepared.kind !== 'static-transform' ||
          prepared.provider !== identity.provider ||
          prepared.path !== entry.path ||
          prepared.sha256 !== entry.sha256
        )
          throw new Error('Native preparation identity differs from inventory.');
        prepareSource(snapshot, filename, prepared.code, prepared.map);
        if (
          prepared.coverageVariable !== variable ||
          typeof prepared.instrumentedCode !== 'string' ||
          digest(prepared.instrumentedCode) !== prepared.instrumentedSha256
        )
          throw new Error('Native instrumented preparation differs.');
        const source = prepared.instrumentedCode;
        loadedSources.push({ path: entry.path, sha256: entry.sha256 });
        return { ...loaded, format: 'module', source };
      } catch (error) {
        rejected.push({ path: entry.path, reason: error.message });
        throw error;
      }
    },
  });
  globalThis[active] = true;
  process.once('exit', (exitCode) => {
    publish(directory, `${id}.completed.json`, {
      ...identity,
      state: 'completed',
      exitCode,
      loadedSources,
      rejected,
      maps: globalThis[variable] ?? {},
    });
    hooks.deregister();
  });
  return id;
}

export async function reconcileNativeCapture(snapshot, directory, direct = {}) {
  const root = realpathSync(snapshot.root);
  const owned = new Map(snapshot.included.map((entry) => [join(root, entry.path), entry]));
  const starts = new Map();
  const completions = new Map();
  const issues = [];
  const files = readdirSync(directory).sort();
  if (!files.length) throw new Error('No native lifecycle records found.');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const { captureCoverage } = await import('./coverage_report.mjs');
  for (const file of files) {
    const record = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    if (
      record?.schema !== 1 ||
      !uuid.test(record.id) ||
      record.provider !== 'istanbul@4.1.11' ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      !Number.isSafeInteger(record.threadId) ||
      record.threadId < 0 ||
      !['started', 'completed'].includes(record.state) ||
      file !== `${record.id}.${record.state}.json`
    )
      throw new Error(`Invalid native lifecycle record: ${file}`);
    const index = record.state === 'started' ? starts : completions;
    if (index.has(record.id)) throw new Error(`Duplicate native lifecycle record: ${record.id}`);
    index.set(record.id, record);
    if (record.state !== 'completed') continue;
    if (
      !Number.isSafeInteger(record.exitCode) ||
      !Array.isArray(record.loadedSources) ||
      !Array.isArray(record.rejected) ||
      !record.maps ||
      typeof record.maps !== 'object' ||
      Array.isArray(record.maps)
    )
      throw new Error(`Invalid native completion: ${file}`);
    const loaded = new Map();
    for (const source of record.loadedSources) {
      const filename = typeof source?.path === 'string' ? join(root, source.path) : '';
      const entry = owned.get(filename);
      if (
        !entry ||
        entry.path !== source.path ||
        source.sha256 !== entry.sha256 ||
        loaded.has(filename)
      )
        throw new Error(`Invalid native loaded source: ${file}`);
      if (digest(readFileSync(filename)) !== entry.sha256)
        throw new Error(`Stale native loaded source: ${source.path}`);
      loaded.set(filename, entry);
    }
    for (const rejection of record.rejected) {
      if (
        typeof rejection?.path !== 'string' ||
        typeof rejection.reason !== 'string' ||
        !snapshot.included.some((entry) => entry.path === rejection.path)
      )
        throw new Error(`Invalid native rejection: ${file}`);
      issues.push({
        kind: 'rejected-execution',
        id: record.id,
        path: rejection.path,
        reason: rejection.reason,
      });
    }
    captureCoverage(snapshot, record.maps, record.id);
    if (!isDeepStrictEqual(Object.keys(record.maps).sort(), [...loaded.keys()].sort()))
      throw new Error(`Native maps differ from loaded source ledger: ${file}`);
  }
  for (const [id, start] of starts) {
    const end = completions.get(id);
    if (!end) {
      issues.push({ kind: 'missing-completion', id });
      continue;
    }
    for (const key of ['pid', 'threadId', 'provider', 'schema'])
      if (start[key] !== end[key]) throw new Error(`Native lifecycle identity differs: ${id}`);
  }
  for (const id of completions.keys())
    if (!starts.has(id)) issues.push({ kind: 'missing-start', id });
  if (issues.length) return { status: 'Fail', processes: starts.size, issues, maps: null };
  const require = createRequire(import.meta.url);
  const providerRequire = createRequire(require.resolve('@vitest/coverage-istanbul'));
  const { createCoverageMap } = providerRequire('istanbul-lib-coverage');
  const { remapNativeCoverage } = await import('@vitest/coverage-istanbul/dist/provider.js');
  const merged = createCoverageMap({});
  for (const record of completions.values()) {
    const remapped = await remapNativeCoverage(createCoverageMap(structuredClone(record.maps)));
    const wire = JSON.parse(JSON.stringify(remapped.toJSON()));
    captureCoverage(snapshot, wire, record.id);
    const maps = Object.fromEntries(
      Object.entries(wire).map(([filename, map]) => {
        const canonical = realpathSync(filename);
        return [canonical, { ...map, path: canonical }];
      }),
    );
    for (const [filename, map] of Object.entries(maps)) {
      if (!record.loadedSources.some((source) => join(root, source.path) === filename))
        throw new Error(`Unexpected remapped native source: ${filename}`);
      const previous = direct[filename];
      if (previous)
        for (const field of ['statementMap', 'fnMap', 'branchMap'])
          if (!isDeepStrictEqual(previous[field], map[field]))
            throw new Error(`Native coverage layout differs from direct: ${filename}.${field}`);
      if (merged.files().includes(filename)) {
        const previous = merged.fileCoverageFor(filename).toJSON();
        for (const field of ['statementMap', 'fnMap', 'branchMap'])
          if (!isDeepStrictEqual(previous[field], map[field]))
            throw new Error(`Native coverage layouts differ: ${filename}.${field}`);
      }
    }
    if (!isDeepStrictEqual(Object.keys(maps).sort(), Object.keys(record.maps).sort()))
      throw new Error(`Native remapping lost loaded sources: ${record.id}`);
    merged.merge(maps);
  }
  return {
    status: 'Pass',
    processes: starts.size,
    issues: [],
    maps: JSON.parse(JSON.stringify(merged.toJSON())),
  };
}
