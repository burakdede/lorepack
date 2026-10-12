import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, globSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function sourceCoverageConfig(root, patterns, inventory, reportsDirectory) {
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
      ...(existsSync(config) ? { extends: config } : { test: { name } }),
      root: folder,
      resolve: { alias },
    };
  });
  return {
    test: {
      projects,
      coverage: {
        provider: 'v8',
        enabled: true,
        include: inventory.included.map((entry) => entry.path),
        exclude: [],
        reporter: ['text', 'json', 'json-summary'],
        reportsDirectory,
      },
    },
  };
}

export function renderCoverageConfig(config) {
  const json = JSON.stringify(config, (_key, value) =>
    value instanceof RegExp ? { regex: value.source } : value,
  );
  return `export default JSON.parse(${JSON.stringify(json)}, (key, value) => key === 'find' && value && typeof value.regex === 'string' ? new RegExp(value.regex) : value);\n`;
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
