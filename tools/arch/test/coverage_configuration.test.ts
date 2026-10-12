import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(rendered.test.projects[0].resolve.alias[0].find).toBeInstanceOf(RegExp);
    expect(rendered.test.projects[0].resolve.alias[0].find.test('@lorepack/core-extra')).toBe(
      false,
    );
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
