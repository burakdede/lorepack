import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertCollectionParity,
  importConfigurations,
  renderCoverageConfig,
  sourceCoverageConfig,
} from '../../../scripts/coverage_configuration.mjs';

let root: string;
const configPath = 'packages/core/vitest.config.ts';
const configCode = "export default {test:{include:['test/*.test.ts'],name:'core'}};";
function put(path: string, code: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), code);
}
function snapshot() {
  return {
    root,
    included: [
      {
        path: configPath,
        sha256: createHash('sha256')
          .update(readFileSync(join(root, configPath)))
          .digest('hex'),
      },
    ],
  };
}
function configuration() {
  return sourceCoverageConfig(root, ['packages/*'], snapshot(), join(root, 'reports'));
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lorepack-capture-config-')));
  for (const name of ['core', 'parsers', 'mcp']) {
    put(
      `packages/${name}/package.json`,
      JSON.stringify({
        name: `@lorepack/${name}`,
        type: 'module',
        exports: { '.': { default: './dist/index.js' }, './nested': './dist/nested.js' },
      }),
    );
    put(`packages/${name}/src/index.ts`, 'export const value = 1;');
    put(`packages/${name}/src/nested.ts`, 'export const nested = 1;');
  }
  put(configPath, configCode);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('source-layout coverage configuration', () => {
  it('uses exact export aliases and retains the parser compiled layout', () => {
    const config = configuration();
    const project = config.test.projects[0];
    if (!project) throw new Error('Missing project.');
    const matches = (name: string) =>
      project.resolve.alias.filter((alias: { find: RegExp }) => alias.find.test(name));
    expect(matches('@lorepack/core')).toHaveLength(1);
    expect(matches('@lorepack/core/nested')).toHaveLength(1);
    expect(matches('@lorepack/core-extra')).toEqual([]);
    expect(matches('@lorepack/core/nested/deeper')).toEqual([]);
    expect(matches('@lorepack/parsers')).toEqual([]);
    expect(matches('@lorepack/parsers/nested')).toEqual([]);
  });

  it('retains configured projects and configless package identities', () => {
    const projects = configuration().test.projects;
    const core = projects.find((project: { root: string }) => basename(project.root) === 'core');
    const mcp = projects.find((project: { root: string }) => basename(project.root) === 'mcp');
    if (!core || !('extends' in core) || !mcp || !('test' in mcp))
      throw new Error('Configured/configless projects were not retained.');
    expect(core.extends).toBe(join(root, configPath));
    expect('extends' in mcp).toBe(false);
    expect(mcp.test.name).toBe('@lorepack/mcp');
  });

  it('renders executable regex aliases and preserves every included source', async () => {
    const config = configuration();
    const file = join(root, 'generated.config.mjs');
    writeFileSync(file, renderCoverageConfig(config));
    const rendered = (await import(pathToFileURL(file).href)).default;
    expect(rendered.test.coverage.include).toEqual([configPath]);
    expect(rendered.test.coverage.exclude).toEqual([]);
    expect(rendered.test.coverage.provider).toBe('istanbul');
    expect(rendered.test.projects[0].resolve.alias[0].find).toBeInstanceOf(RegExp);
    expect(rendered.test.projects[0].resolve.alias[0].find.test('@lorepack/core-extra')).toBe(
      false,
    );
  });

  it('runs capture setup alongside inherited project setup in a real worker', () => {
    const repository = join(import.meta.dirname, '../../..');
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'junction');
    put(
      configPath,
      "export default {test:{include:['test/*.test.ts'],name:'core',setupFiles:['./setup.ts']}};",
    );
    put('packages/core/setup.ts', 'globalThis.inheritedSetup = true;');
    const setup = join(root, 'capture-setup.ts');
    put('capture-setup.ts', 'globalThis.captureSetup = true;');
    put(
      'packages/core/test/setup.test.ts',
      `import {expect,test} from 'vitest';
test('both setup hooks execute',()=>{expect(globalThis.inheritedSetup).toBe(true);expect(globalThis.captureSetup).toBe(true);});`,
    );
    const config = sourceCoverageConfig(
      root,
      ['packages/core'],
      snapshot(),
      join(root, 'reports'),
      setup,
    );
    const generated = join(root, 'generated.config.mjs');
    writeFileSync(generated, renderCoverageConfig(config));
    const require = createRequire(join(repository, 'package.json'));
    const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
    expect(() =>
      execFileSync(process.execPath, [vitest, 'run', '--config', generated], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('rejects absent default projects', () => {
    expect(() =>
      sourceCoverageConfig(root, ['missing/*'], snapshot(), join(root, 'reports')),
    ).toThrow('Default test projects are missing');
  });

  it('rejects unsupported project declarations and non-directory projects', () => {
    expect(() => sourceCoverageConfig(root, [42], snapshot(), join(root, 'reports'))).toThrow(
      'explicit default project patterns',
    );
    expect(() =>
      sourceCoverageConfig(root, ['packages/core/package.json'], snapshot(), join(root, 'reports')),
    ).toThrow('Test project is not a directory');
  });

  it('imports actual owned configurations and checks their semantics', async () => {
    expect(await importConfigurations(snapshot())).toEqual([
      { path: configPath, imported: true, configurationAssertions: 'passed' },
    ]);
  });

  it('refuses stale config bytes before evaluating changed code', async () => {
    const previous = snapshot();
    put(configPath, "throw new Error('Changed configuration executed.');");
    await expect(importConfigurations(previous)).rejects.toThrow('Stale configuration source');
  });

  it('rejects configuration semantics that no longer meet the capture contract', async () => {
    put(configPath, 'export default {test:{include:[]}};');
    await expect(importConfigurations(snapshot())).rejects.toThrow();
  });

  it('requires at least one owned configuration', async () => {
    await expect(importConfigurations({ root, included: [] })).rejects.toThrow(
      'No owned configurations',
    );
  });

  it('checks complete file and project parity', () => {
    const collection = [{ file: join(root, configPath), projectName: 'core' }];
    expect(assertCollectionParity(collection, collection)).toEqual({ files: 1, status: 'Pass' });
    expect(() => assertCollectionParity(collection, [])).toThrow('collection differs');
    expect(() =>
      assertCollectionParity(collection, [{ ...collection[0], projectName: 'renamed' }]),
    ).toThrow('collection differs');
    expect(() =>
      assertCollectionParity([...collection, ...collection], [...collection, ...collection]),
    ).toThrow('collection differs');
  });
});

describe('source-bound transformation preparation', () => {
  it('binds the actual transform to unchanged original source bytes', async () => {
    const { prepareSource } = await import('../../../scripts/coverage_configuration.mjs');
    const inventory = snapshot();
    const id = join(root, configPath);
    const prepared = prepareSource(inventory, id, configCode, null);
    expect(prepared.kind).toBe('static-transform');
    expect(prepared.path).toBe(configPath);
    expect(prepared.sha256).toBe(inventory.included[0]?.sha256);
    expect(prepared.code).toBe(configCode);
    expect('s' in prepared).toBe(false);
    expect('f' in prepared).toBe(false);
    expect('b' in prepared).toBe(false);
    put(configPath, 'export default {};');
    expect(() => prepareSource(inventory, id, configCode, null)).toThrow('Stale preparation');
  });

  it('rejects transformed code without the original mapped content', async () => {
    const { prepareSource } = await import('../../../scripts/coverage_configuration.mjs');
    const inventory = snapshot();
    const id = join(root, configPath);
    const code = 'export default { test: { include: ["test/*.test.ts"], name: "core" } };';
    expect(() => prepareSource(inventory, id, code, null)).toThrow('source map');
    const map = {
      version: 3,
      sources: [id],
      sourcesContent: [configCode],
      mappings: '',
      names: [],
    };
    expect(prepareSource(inventory, id, code, map).map).toEqual(map);
    expect(() => prepareSource(inventory, id, code, { ...map, sourcesContent: ['wrong'] })).toThrow(
      'mapped original',
    );
    expect(() =>
      prepareSource(inventory, id, code, { ...map, sources: [join(root, 'other.ts')] }),
    ).toThrow('mapped source');
    expect(() => prepareSource(inventory, id, code, { ...map, version: 2 })).toThrow('source map');
  });

  it('rejects unowned paths and unrelated query variants', async () => {
    const { prepareSource } = await import('../../../scripts/coverage_configuration.mjs');
    expect(() => prepareSource(snapshot(), join(root, 'unowned.ts'), '', null)).toThrow('Unowned');
    expect(() =>
      prepareSource(snapshot(), `${join(root, configPath)}?wrapped`, configCode, null),
    ).toThrow('query');
  });
});

it('retains canonical JSX preparations for reporting-only debug filenames', async () => {
  const { preparingInstrumenter } = await import('../../../scripts/coverage_configuration.mjs');
  const repository = join(import.meta.dirname, '../../..');
  const require = createRequire(join(repository, 'package.json'));
  const viteRequire = createRequire(require.resolve('vitest/package.json'));
  const { transformWithOxc } = await import(pathToFileURL(viteRequire.resolve('vite')).href);
  const source = 'export function Widget() { return <div>Hello</div>; }';
  put('widget.tsx', source);
  const id = join(root, 'widget.tsx');
  const reportingId = `${id}?cache=123&vitest-uncovered-coverage=true`;
  const options = {
    lang: 'tsx',
    sourcemap: true,
    jsx: { runtime: 'automatic', development: true },
  };
  const ordinary = await transformWithOxc(source, id, options);
  const reporting = await transformWithOxc(source, reportingId, options);
  expect(ordinary.code).toContain(`var _jsxFileName = ${JSON.stringify(id)};`);
  expect(reporting.code).toContain(JSON.stringify(reportingId));
  const map = { ...reporting.map, sources: ordinary.map.sources };
  expect(map.mappings).toBe(ordinary.map.mappings);
  expect(map.sourcesContent).toEqual(ordinary.map.sourcesContent);
  const inventory = {
    root,
    included: [{ path: 'widget.tsx', sha256: createHash('sha256').update(source).digest('hex') }],
  };
  const directory = join(root, 'preparations');
  const factory = await preparingInstrumenter(inventory, directory);
  const instrumenter = factory({ coverageVariable: '__witness__' });
  instrumenter.instrumentSync(ordinary.code, id, ordinary.map);
  const filename = join(
    directory,
    `${createHash('sha256').update('widget.tsx').digest('hex')}.json`,
  );
  const retained = readFileSync(filename, 'utf8');
  expect(() => instrumenter.instrumentSync(reporting.code, id, map)).toThrow(
    'Conflicting preparation',
  );
  const emitted = instrumenter.instrumentSync(reporting.code, reportingId, map);
  expect(emitted).toContain(JSON.stringify(reportingId));
  expect(readFileSync(filename, 'utf8')).toBe(retained);
  expect(() =>
    instrumenter.instrumentSync(reporting.code.replace('Hello', 'Other'), reportingId, map),
  ).toThrow('Conflicting preparation');
});

it('preserves preparations when a later transform conflicts', async () => {
  const { preparingInstrumenter } = await import('../../../scripts/coverage_configuration.mjs');
  const directory = join(root, 'preparations');
  const factory = await preparingInstrumenter(snapshot(), directory);
  const instrumenter = factory({ coverageVariable: '__witness__' });
  const id = join(root, configPath);
  const map = { version: 3, sources: [id], sourcesContent: [configCode], mappings: '', names: [] };
  instrumenter.instrumentSync(configCode, id, map);
  const filename = join(directory, `${createHash('sha256').update(configPath).digest('hex')}.json`);
  const original = readFileSync(filename, 'utf8');
  expect(() => instrumenter.instrumentSync(`${configCode}\n`, id, map)).toThrow(
    'Conflicting preparation',
  );
  expect(readFileSync(filename, 'utf8')).toBe(original);
  expect(readdirSync(directory)).toEqual([basename(filename)]);
});

it('rechecks original bytes during the provider synthetic-map pass', async () => {
  const { preparingInstrumenter } = await import('../../../scripts/coverage_configuration.mjs');
  const factory = await preparingInstrumenter(snapshot(), join(root, 'preparations'));
  const instrumenter = factory({ coverageVariable: '__witness__' });
  const id = join(root, configPath);
  const code = `${configCode}\n`;
  instrumenter.instrumentSync(code, id, {
    version: 3,
    sources: [id],
    sourcesContent: [configCode],
    mappings: '',
    names: [],
  });
  put(configPath, 'export default {};');
  expect(() =>
    instrumenter.instrumentSync(code, id, {
      version: 3,
      sources: [id],
      sourcesContent: [code],
      mappings: '',
      names: [],
    }),
  ).toThrow('Stale preparation');
});

it('binds equivalent filesystem spellings to the owned canonical source', async () => {
  const { prepareSource } = await import('../../../scripts/coverage_configuration.mjs');
  const id = `${dirname(join(root, configPath))}/./${basename(configPath)}`;
  const map = { version: 3, sources: [id], sourcesContent: [configCode], mappings: '', names: [] };
  expect(prepareSource(snapshot(), id, configCode, map).path).toBe(configPath);
});

it('prepares configurations with original mapped content and no execution hits', async () => {
  const { prepareConfigurations } = await import('../../../scripts/coverage_configuration.mjs');
  const preparedDirectory = join(root, 'config-preparations');
  const prepared = await prepareConfigurations(snapshot(), preparedDirectory);
  expect(prepared.included.map((entry: { path: string }) => entry.path)).toEqual([configPath]);
  const records = readdirSync(preparedDirectory).map((file) =>
    JSON.parse(readFileSync(join(preparedDirectory, file), 'utf8')),
  );
  expect(records).toHaveLength(1);
  expect(records[0].map.sourcesContent).toEqual([configCode]);
  expect(records[0].sha256).toBe(snapshot().included[0]?.sha256);
  expect('s' in records[0]).toBe(false);
});
