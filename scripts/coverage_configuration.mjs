import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  globSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function sourceCoverageConfig(root, patterns, inventory, reportsDirectory, setupFile = '') {
  root = realpathSync(root);
  const alias = [];
  for (const directory of readdirSync(join(root, 'packages'))) {
    const folder = join(root, 'packages', directory);
    const manifest = join(folder, 'package.json');
    if (!existsSync(manifest)) continue;
    const meta = JSON.parse(readFileSync(manifest, 'utf8'));
    if (meta.name === '@lorepack/parsers') continue;
    for (const [subpath, target] of Object.entries(meta.exports ?? {})) {
      const exported = typeof target === 'string' ? target : target.default;
      if (
        typeof exported !== 'string' ||
        !exported.startsWith('./dist/') ||
        !exported.endsWith('.js')
      )
        continue;
      const source = join(folder, exported.replace('./dist/', './src/').replace(/\.js$/, '.ts'));
      if (!existsSync(source)) continue;
      const specifier = meta.name + (subpath === '.' ? '' : subpath.slice(1));
      alias.push({
        find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
        replacement: source,
      });
    }
  }
  if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== 'string'))
    throw new Error('Coverage capture requires the explicit default project patterns.');
  const folders = [
    ...new Set(patterns.flatMap((pattern) => globSync(pattern, { cwd: root }))),
  ].sort();
  if (!folders.length) throw new Error('Default test projects are missing.');
  const projects = folders.map((path) => {
    const folder = join(root, path);
    if (!lstatSync(folder).isDirectory())
      throw new Error(`Test project is not a directory: ${path}`);
    const config = join(folder, 'vitest.config.ts');
    const manifest = join(folder, 'package.json');
    const name = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).name : undefined;
    return {
      ...(existsSync(config) ? { extends: config } : {}),
      ...(!existsSync(config) || setupFile
        ? {
            test: {
              ...(!existsSync(config) ? { name } : {}),
              ...(setupFile ? { setupFiles: [setupFile] } : {}),
            },
          }
        : {}),
      root: folder,
      resolve: { alias },
    };
  });
  return {
    test: {
      projects,
      coverage: {
        provider: 'istanbul',
        enabled: true,
        include: inventory.included.map((entry) => entry.path),
        exclude: [],
        reporter: ['text', 'json', 'json-summary'],
        reportsDirectory,
      },
    },
  };
}

export function renderCoverageConfig(config, preparation) {
  const json = JSON.stringify(config, (_key, value) =>
    value instanceof RegExp ? { regex: value.source } : value,
  );
  const prefix = preparation
    ? `import { preparingInstrumenter } from ${JSON.stringify(import.meta.url)};\n`
    : '';
  const suffix = preparation
    ? `\nconfig.test.coverage.instrumenter = await preparingInstrumenter(${JSON.stringify(preparation.snapshot)}, ${JSON.stringify(preparation.directory)});`
    : '';
  return `${prefix}const config = JSON.parse(${JSON.stringify(json)}, (key, value) => key === 'find' && value && typeof value.regex === 'string' ? new RegExp(value.regex) : value);${suffix}\nexport default config;\n`;
}

export function assertCollectionParity(ordinary, measured) {
  const identity = (entry) => `${entry.projectName}\0${realpathSync(entry.file)}`;
  const before = ordinary.map(identity).sort();
  const after = measured.map(identity).sort();
  const missing = before.filter((entry) => !after.includes(entry));
  const extra = after.filter((entry) => !before.includes(entry));
  if (
    missing.length ||
    extra.length ||
    before.length !== after.length ||
    new Set(before).size !== before.length ||
    new Set(after).size !== after.length
  )
    throw new Error(`Source-layout collection differs: ${JSON.stringify({ missing, extra })}`);
  return { files: before.length, status: 'Pass' };
}

export async function importConfigurations(snapshot) {
  const root = realpathSync(snapshot.root);
  const results = [];
  for (const { path, sha256 } of snapshot.included.filter((entry) =>
    /(?:vite|vitest)\.config\.ts$/.test(entry.path),
  )) {
    if (
      createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex') !== sha256
    )
      throw new Error(`Stale configuration source: ${path}`);
    const config = (await import(pathToFileURL(join(root, path)).href)).default;
    assert.ok(config && typeof config === 'object', `${path}: expected configuration`);
    if (path === 'apps/studio/vite.config.ts') {
      assert.equal(config.base, './');
      assert.equal(config.build.outDir, '../../packages/cli/studio-dist');
      assert.equal(config.server.proxy['/v1'], config.server.proxy['/health']);
    } else {
      assert.ok(config.test, `${path}: test configuration missing`);
      if (path === 'vitest.config.ts') {
        assert.ok(config.test.projects.includes('packages/*'));
        assert.ok(!config.test.projects.includes('tools/acceptance'));
      } else assert.ok(config.test.include.length > 0);
      if (path === 'apps/studio/vitest.config.ts') {
        assert.equal(config.test.environment, 'jsdom');
        assert.equal(config.test.globals, true);
        assert.ok(config.test.setupFiles.includes('./test/setup.ts'));
      }
      if (
        path === 'packages/cli/vitest.config.ts' ||
        path === 'tools/acceptance/vitest.config.ts'
      ) {
        assert.equal(config.test.fileParallelism, false);
        assert.equal(config.test.maxWorkers, 1);
      }
    }
    results.push({ path, imported: true, configurationAssertions: 'passed' });
  }
  if (!results.length) throw new Error('No owned configurations found.');
  return results;
}

export function prepareSource(snapshot, id, code, map) {
  const [input, query] = id.split('?');
  const source = resolve(input);
  if (query !== undefined && !/^(?:cache=\d+&)?vitest-uncovered-coverage=true$/.test(query))
    throw new Error(`Unsupported preparation query: ${id}`);
  const root = realpathSync(snapshot.root);
  const entry = snapshot.included.find((value) => join(root, value.path) === source);
  if (!entry) throw new Error(`Unowned preparation source: ${id}`);
  const bytes = readFileSync(source);
  const original = bytes.toString('utf8');
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  if (hash(bytes) !== entry.sha256) throw new Error(`Stale preparation source: ${id}`);
  if (typeof code !== 'string') throw new Error(`Invalid preparation code: ${id}`);
  if (map != null) {
    if (
      map.version !== 3 ||
      !Array.isArray(map.sources) ||
      map.sources.length !== 1 ||
      !Array.isArray(map.sourcesContent) ||
      map.sourcesContent.length !== 1 ||
      typeof map.sources[0] !== 'string' ||
      typeof map.mappings !== 'string'
    )
      throw new Error(`Invalid preparation source map: ${id}`);
    const mapped = map.sources[0].startsWith('file:')
      ? fileURLToPath(map.sources[0])
      : resolve(dirname(source), map.sourceRoot ?? '', map.sources[0]);
    if (mapped !== source) throw new Error(`Preparation mapped source differs: ${id}`);
    if (map.sourcesContent[0] !== original)
      throw new Error(`Preparation mapped original differs: ${id}`);
  } else if (code !== original)
    throw new Error(`Transformed preparation requires a source map: ${id}`);
  return {
    schema: 1,
    kind: 'static-transform',
    provider: 'istanbul@4.1.11',
    path: entry.path,
    sha256: entry.sha256,
    code,
    map: map == null ? null : JSON.parse(JSON.stringify(map)),
  };
}

export async function preparingInstrumenter(snapshot, directory) {
  const { createNativeInstrumenter } = await import('@vitest/coverage-istanbul/dist/provider.js');
  mkdirSync(directory, { recursive: true });
  const plugins = createNativeInstrumenter().opts.parserPlugins;
  return (options) => {
    const instrumenter = createNativeInstrumenter({
      ...options,
      produceSourceMap: true,
      autoWrap: false,
      esModules: true,
      compact: false,
      parserPlugins: [...plugins, ['importAttributes', { deprecatedAssertSyntax: true }]],
      generatorOpts: { importAttributesKeyword: 'with' },
      ignoreLines: true,
    });
    const instrument = instrumenter.instrumentSync.bind(instrumenter);
    let previous;
    instrumenter.instrumentSync = (code, id, map) => {
      // Vitest's second pass builds a synthetic transform map; its code is not executed.
      if (
        previous?.id === id &&
        previous.code === code &&
        map?.version === 3 &&
        map.sources?.length === 1 &&
        map.sources[0] === id.split('?')[0] &&
        map.sourcesContent?.length === 1 &&
        map.sourcesContent[0] === code &&
        typeof map.mappings === 'string'
      ) {
        prepareSource(snapshot, id, previous.code, previous.map);
        previous = undefined;
        return instrument(code, id, map);
      }
      const prepared = prepareSource(snapshot, id, code, map);
      const payload = `${JSON.stringify(prepared)}\n`;
      const filename = join(
        directory,
        `${createHash('sha256').update(prepared.path).digest('hex')}.json`,
      );
      const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, payload, { flag: 'wx' });
      try {
        try {
          linkSync(temporary, filename);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (readFileSync(filename, 'utf8') !== payload)
            throw new Error(`Conflicting preparation transforms: ${prepared.path}`);
        }
      } finally {
        unlinkSync(temporary);
      }
      previous = { id, code, map: prepared.map };
      return instrument(code, id, map);
    };
    return instrumenter;
  };
}

export async function prepareConfigurations(snapshot, directory) {
  const included = snapshot.included.filter((entry) =>
    /(?:vite|vitest)\.config\.ts$/.test(entry.path),
  );
  if (!included.length) throw new Error('No owned configurations found.');
  const configurations = { ...snapshot, root: realpathSync(snapshot.root), included };
  const require = createRequire(import.meta.url);
  const vitestRequire = createRequire(require.resolve('vitest/package.json'));
  const { transformWithOxc } = await import(pathToFileURL(vitestRequire.resolve('vite')).href);
  const factory = await preparingInstrumenter(configurations, directory);
  const instrumenter = factory({
    coverageVariable: '__LOREPACK_PREPARATION_ONLY__',
    coverageGlobalScope: 'globalThis',
    coverageGlobalScopeFunc: false,
  });
  for (const entry of included) {
    const filename = join(configurations.root, entry.path);
    const bytes = readFileSync(filename);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
      throw new Error(`Stale configuration preparation: ${entry.path}`);
    const transformed = await transformWithOxc(bytes.toString('utf8'), filename, {
      lang: 'ts',
      target: 'esnext',
      sourcemap: true,
    });
    instrumenter.instrumentSync(transformed.code, filename, transformed.map);
  }
  return configurations;
}
