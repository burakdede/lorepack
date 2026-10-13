import { createHash, randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { threadId } from 'node:worker_threads';
import { prepareSource } from './coverage_configuration.mjs';

const active = Symbol.for('lorepack.nativeCoverageCollector');
const variable = '__LOREPACK_NATIVE_COVERAGE__';
const digest = (value) => createHash('sha256').update(value).digest('hex');

export function compiledCapturePlugin(snapshot, preparations) {
  const root = realpathSync(snapshot.root);
  const artifacts = new Map(
    snapshot.included
      .filter((entry) => /\.tsx?$/.test(entry.path))
      .map((entry) => {
        const compiled = entry.path.includes('/src/')
          ? entry.path.replace('/src/', '/dist/')
          : `dist/${entry.path}`;
        return [join(root, compiled.replace(/\.tsx?$/, '.js')), entry];
      }),
  );
  const receipts = new Map();
  return {
    receipts,
    plugin: {
      name: 'source-bound-compiled-capture',
      setup(builder) {
        builder.onLoad({ filter: /\.js$/ }, (args) => {
          const filename = resolve(args.path);
          const entry = artifacts.get(filename);
          if (!entry) {
            if (/^packages\/[^/]+\/dist\//.test(relative(root, filename).split(sep).join('/')))
              throw new Error(`Unowned compiled capture input: ${filename}`);
            return;
          }
          const bytes = readFileSync(filename);
          const mapBytes = readFileSync(`${filename}.map`);
          const map = JSON.parse(mapBytes.toString('utf8'));
          if (
            map.version !== 3 ||
            map.file !== basename(filename) ||
            !Array.isArray(map.sources) ||
            map.sources.length !== 1 ||
            typeof map.sources[0] !== 'string' ||
            typeof map.mappings !== 'string'
          )
            throw new Error(`Unsupported compiled capture map: ${filename}`);
          const source = map.sources[0].startsWith('file:')
            ? fileURLToPath(map.sources[0])
            : resolve(dirname(filename), map.sourceRoot ?? '', map.sources[0]);
          if (source !== join(root, entry.path))
            throw new Error(`Compiled capture mapped source differs: ${filename}`);
          const prepared = JSON.parse(
            readFileSync(join(preparations, `${digest(entry.path)}.json`), 'utf8'),
          );
          const expected = prepareSource(snapshot, source, prepared.code, prepared.map);
          for (const key of ['schema', 'kind', 'provider', 'path', 'sha256'])
            if (prepared[key] !== expected[key])
              throw new Error(`Compiled preparation identity differs: ${entry.path}`);
          if (
            prepared.coverageVariable !== variable ||
            typeof prepared.instrumentedCode !== 'string' ||
            digest(prepared.instrumentedCode) !== prepared.instrumentedSha256
          )
            throw new Error(`Compiled instrumented preparation differs: ${entry.path}`);
          if (
            map.sourcesContent != null &&
            (!Array.isArray(map.sourcesContent) ||
              map.sourcesContent.length !== 1 ||
              map.sourcesContent[0] !== readFileSync(source, 'utf8'))
          )
            throw new Error(`Compiled capture mapped content differs: ${filename}`);
          const receipt = {
            path: entry.path,
            sha256: entry.sha256,
            artifact: filename,
            artifactSha256: digest(bytes),
            artifactMapSha256: digest(mapBytes),
            instrumentedSha256: prepared.instrumentedSha256,
          };
          if (receipts.has(filename) && !isDeepStrictEqual(receipts.get(filename), receipt))
            throw new Error(`Compiled input changed between loads: ${filename}`);
          receipts.set(filename, receipt);
          return {
            contents: prepared.instrumentedCode,
            loader: 'js',
            resolveDir: dirname(filename),
          };
        });
      },
    },
  };
}

export function registerCounterStream(fd) {
  if (!Number.isSafeInteger(fd) || fd < 4)
    throw new Error('Counter stream requires a separate inherited descriptor.');
  if (globalThis[active] || Object.hasOwn(globalThis, variable))
    throw new Error('Native coverage collector already registered or counters already exist.');
  const identity = {
    schema: 1,
    id: randomUUID(),
    pid: process.pid,
    threadId,
    provider: 'istanbul@4.1.11',
  };
  let sequence = 0;
  const emit = (record) => {
    const bytes = Buffer.from(`${JSON.stringify({ ...record, sequence: ++sequence })}\n`);
    if (writeSync(fd, bytes) !== bytes.length)
      throw new Error('Incomplete native counter stream write.');
  };
  const counters = (target, path, field, key) =>
    new Proxy(target, {
      set(object, counter, value) {
        emit({
          state: 'counter',
          path,
          field,
          key: key ?? counter,
          ...(field === 'b' ? { arm: Number(counter) } : {}),
          value,
        });
        object[counter] = value;
        return true;
      },
    });
  emit({ ...identity, state: 'started' });
  globalThis[variable] = new Proxy(
    {},
    {
      set(object, path, data) {
        emit({ state: 'source', path, data });
        data.s = counters(data.s, path, 's');
        data.f = counters(data.f, path, 'f');
        for (const key of Object.keys(data.b)) data.b[key] = counters(data.b[key], path, 'b', key);
        object[path] = data;
        return true;
      },
    },
  );
  globalThis[active] = true;
  process.once('exit', (exitCode) => emit({ ...identity, state: 'completed', exitCode }));
  return identity.id;
}

export async function replayCounterStream(snapshot, text) {
  if (typeof text !== 'string' || !text || !text.endsWith('\n'))
    throw new Error('Empty or truncated native counter stream.');
  const records = text
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line));
  const start = records[0];
  if (
    start.state !== 'started' ||
    start.schema !== 1 ||
    start.provider !== 'istanbul@4.1.11' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(start.id) ||
    !Number.isSafeInteger(start.pid) ||
    start.pid <= 0 ||
    !Number.isSafeInteger(start.threadId) ||
    start.threadId < 0
  )
    throw new Error('Invalid native counter stream identity.');
  const root = realpathSync(snapshot.root);
  const owned = new Map(snapshot.included.map((entry) => [join(root, entry.path), entry]));
  const maps = {};
  const { captureCoverage } = await import('./coverage_report.mjs');
  let sequence = 0;
  let completed = null;
  for (const record of records) {
    if (completed || record.sequence !== ++sequence)
      throw new Error('Native counter stream sequence differs.');
    if (sequence === 1) continue;
    if (record.state === 'source') {
      const entry = owned.get(record.path);
      if (!entry || Object.hasOwn(maps, record.path) || record.data?.path !== record.path)
        throw new Error('Invalid or repeated native counter source.');
      if (digest(readFileSync(record.path)) !== entry.sha256)
        throw new Error(`Stale native counter source: ${entry.path}`);
      captureCoverage(snapshot, { [record.path]: record.data }, start.id);
      if (
        [
          ...Object.values(record.data.s),
          ...Object.values(record.data.f),
          ...Object.values(record.data.b).flat(),
        ].some((value) => value !== 0)
      )
        throw new Error('Native counter source starts with execution hits.');
      maps[record.path] = record.data;
    } else if (record.state === 'counter') {
      const map = maps[record.path];
      if (
        !map ||
        !['s', 'f', 'b'].includes(record.field) ||
        typeof record.key !== 'string' ||
        !Object.hasOwn(map[record.field], record.key)
      )
        throw new Error('Unknown native counter.');
      const target = record.field === 'b' ? map.b[record.key] : map[record.field];
      const key = record.field === 'b' ? record.arm : record.key;
      if (record.field === 'b' && (!Number.isSafeInteger(key) || key < 0 || key >= target.length))
        throw new Error('Unknown native branch arm.');
      if (!Number.isSafeInteger(record.value) || record.value !== target[key] + 1)
        throw new Error('Native counter increment differs.');
      target[key] = record.value;
    } else if (record.state === 'completed') {
      for (const key of ['id', 'schema', 'provider', 'pid', 'threadId'])
        if (record[key] !== start[key])
          throw new Error('Native counter completion identity differs.');
      if (!Number.isSafeInteger(record.exitCode))
        throw new Error('Invalid native counter exit code.');
      completed = record;
    } else throw new Error('Unknown native counter stream record.');
  }
  captureCoverage(snapshot, maps, start.id);
  return {
    id: start.id,
    pid: start.pid,
    threadId: start.threadId,
    state: completed ? 'completed' : 'interrupted',
    exitCode: completed?.exitCode ?? null,
    maps,
  };
}

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
