import { createHash, randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
