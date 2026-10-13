import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  assertCollectionParity,
  importConfigurations,
  renderCoverageConfig,
  sourceCoverageConfig,
} from './coverage_configuration.mjs';

export function nodeCommand(root, args, environment = {}) {
  execFileSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...environment },
  });
}

export async function captureCampaign(root, output, pnpmEntrypoint) {
  root = realpathSync(root);
  if (!pnpmEntrypoint) throw new Error('Run the capture through pnpm coverage:capture.');
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  const require = createRequire(join(root, 'package.json'));
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  nodeCommand(root, [pnpmEntrypoint, 'build']);
  const inventoryPath = join(output, 'inventory.json');
  nodeCommand(root, [join(root, 'scripts/coverage_inventory.mjs'), '--out', inventoryPath]);
  const inventory = json(inventoryPath);
  const { default: base } = await import(pathToFileURL(join(root, 'vitest.config.ts')).href);
  const configPath = join(output, 'source.config.mjs');
  const directDirectory = join(output, 'direct');
  writeFileSync(
    configPath,
    renderCoverageConfig(
      sourceCoverageConfig(root, base.test.projects, inventory, directDirectory),
      { snapshot: inventory, directory: join(output, 'preparations') },
    ),
  );
  const ordinary = join(output, 'ordinary.files.json');
  const measured = join(output, 'measured.files.json');
  nodeCommand(root, [vitest, 'list', '--filesOnly', `--json=${ordinary}`]);
  nodeCommand(root, [vitest, 'list', '--config', configPath, '--filesOnly', `--json=${measured}`]);
  save(
    join(output, 'collection.parity.json'),
    assertCollectionParity(json(ordinary), json(measured)),
  );
  const rawConfigs = join(output, 'configs-v8');
  nodeCommand(
    root,
    [
      join(root, 'scripts/coverage_capture.mjs'),
      '--import-configs',
      inventoryPath,
      '--results',
      join(output, 'configuration.imports.json'),
    ],
    { NODE_V8_COVERAGE: rawConfigs },
  );
  const rawChildren = join(output, 'children-v8');
  nodeCommand(root, [vitest, 'run', '--config', configPath], { NODE_V8_COVERAGE: rawChildren });
  const directMap = join(directDirectory, 'coverage-final.json');
  const directBundle = join(output, 'direct.bundle.json');
  nodeCommand(root, [
    join(root, 'scripts/coverage_report.mjs'),
    '--capture',
    inventoryPath,
    '--map',
    directMap,
    '--origin',
    'direct',
    '--out',
    directBundle,
  ]);
  const bundles = [directBundle];
  for (const [origin, raw] of [
    ['configs', rawConfigs],
    ['children', rawChildren],
  ]) {
    const bundle = join(output, `${origin}.bundle.json`);
    nodeCommand(root, [
      join(root, 'scripts/coverage_native.mjs'),
      '--inventory',
      inventoryPath,
      '--raw',
      raw,
      '--direct',
      directMap,
      '--origin',
      origin,
      '--out',
      bundle,
    ]);
    bundles.push(bundle);
  }
  nodeCommand(root, [
    join(root, 'scripts/coverage_report.mjs'),
    ...bundles.flatMap((bundle) => ['--input', bundle]),
    '--out',
    join(output, 'report.json'),
  ]);
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        out: { type: 'string' },
        'import-configs': { type: 'string' },
        results: { type: 'string' },
      },
    });
    if (values['import-configs'] && values.results && !values.out) {
      const snapshot = JSON.parse(readFileSync(values['import-configs'], 'utf8'));
      const imported = await importConfigurations(snapshot);
      writeFileSync(values.results, `${JSON.stringify(imported, null, 2)}\n`);
    } else if (values.out && !values['import-configs'] && !values.results) {
      await captureCampaign(
        realpathSync(join(import.meta.dirname, '..')),
        resolve(values.out),
        process.env.npm_execpath,
      );
    } else
      throw new Error(
        'Use --out <fresh artifact directory>, or --import-configs <inventory> --results <file>.',
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
