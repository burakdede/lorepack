import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  assertCollectionParity,
  importConfigurations,
  prepareConfigurations,
  renderCoverageConfig,
  sourceCoverageConfig,
} from './coverage_configuration.mjs';
import {
  buildNativeCli,
  createCampaignRegistry,
  prepareNativeCapture,
  reconcileForkCapture,
  reconcileNativeCapture,
} from './coverage_instrumented.mjs';
import { captureCoverage } from './coverage_report.mjs';

export function nodeCommand(root, args, environment = {}) {
  execFileSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...environment },
  });
}

export function writeCampaignSetup(snapshot, launch, filename) {
  writeFileSync(
    filename,
    `import {afterAll} from 'vitest';
import {registerCampaignCapture} from ${JSON.stringify(new URL('./coverage_instrumented.mjs', import.meta.url).href)};
const capture=registerCampaignCapture(${JSON.stringify(snapshot)},${JSON.stringify(launch)});
afterAll(async()=>{try{await capture.settled();}finally{capture.restore();}});
`,
    { flag: 'wx' },
  );
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
  const preparations = join(output, 'preparations');
  const preparationConfig = join(output, 'preparation.config.mjs');
  writeFileSync(
    preparationConfig,
    renderCoverageConfig(
      sourceCoverageConfig(
        root,
        base.test.projects,
        inventory,
        join(output, 'preparation-direct'),
        '',
        base.test,
      ),
      { snapshot: inventory, directory: preparations },
    ),
  );
  nodeCommand(root, [vitest, 'run', '--config', preparationConfig]);
  const preparedPaths = new Set(
    readdirSync(preparations).map((file) => json(join(preparations, file)).path),
  );
  const missing = inventory.included.filter((entry) => !preparedPaths.has(entry.path));
  if (missing.some((entry) => !/(?:vite|vitest)\.config\.ts$/.test(entry.path)))
    throw new Error('Campaign has missing executable preparations.');
  const nativeSnapshot = {
    ...inventory,
    included: inventory.included.filter((entry) => preparedPaths.has(entry.path)),
  };
  const native = join(output, 'native-preparations');
  await prepareNativeCapture(
    nativeSnapshot,
    preparations,
    native,
    '__LOREPACK_CAMPAIGN_COVERAGE__',
  );
  const built = await buildNativeCli(
    inventory,
    native,
    join(output, 'measurement/dist'),
    '__LOREPACK_CAMPAIGN_COVERAGE__',
  );
  save(join(output, 'native-build.json'), built);
  const setup = join(output, 'worker-setup.mjs');
  writeCampaignSetup(inventory, built.launch, setup);
  const configPath = join(output, 'source.config.mjs');
  const directDirectory = join(output, 'direct');
  writeFileSync(
    configPath,
    renderCoverageConfig(
      sourceCoverageConfig(root, base.test.projects, inventory, directDirectory, setup, base.test),
      { snapshot: inventory, directory: preparations },
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
  const configurations = await captureConfigurations(inventory, join(output, 'configs-native'));
  const configBundle = join(output, 'configs.bundle.json');
  save(configBundle, configurations);
  nodeCommand(root, [vitest, 'run', '--config', configPath]);
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
  const registry = createCampaignRegistry(inventory, built.launch);
  const children = await reconcileForkCapture(
    inventory,
    built.launch.captureDirectory,
    [...registry.forkEntries, ...registry.commandEntries],
    json(directMap),
  );
  save(join(output, 'children.reconciliation.json'), children);
  if (children.status !== 'Pass') throw new Error('Campaign native children failed qualification.');
  const childBundle = join(output, 'children.bundle.json');
  save(childBundle, {
    ...captureCoverage(inventory, children.maps, 'children'),
    nativeEvidence: { acceptedExecutions: children.processes, rejected: [] },
  });
  const bundles = [directBundle, configBundle, childBundle];
  nodeCommand(root, [
    join(root, 'scripts/coverage_report.mjs'),
    ...bundles.flatMap((bundle) => ['--input', bundle]),
    '--out',
    join(output, 'report.json'),
  ]);
}

export async function captureConfigurations(snapshot, output) {
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  const preparations = join(output, 'preparations');
  const configurations = await prepareConfigurations(snapshot, preparations);
  const nativePreparations = join(output, 'native-preparations');
  await prepareNativeCapture(configurations, preparations, nativePreparations);
  const raw = join(output, 'records');
  const bootstrap = join(output, 'bootstrap.mjs');
  writeFileSync(
    bootstrap,
    `import {registerNativeCapture} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'coverage_instrumented.mjs')).href)}; await registerNativeCapture(${JSON.stringify(configurations)},${JSON.stringify(nativePreparations)},${JSON.stringify(raw)});\n`,
  );
  const entry = join(output, 'import-configurations.mjs');
  const results = join(output, 'configuration.imports.json');
  writeFileSync(
    entry,
    `import {writeFileSync} from 'node:fs'; import {importConfigurations} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'coverage_configuration.mjs')).href)}; const results = await importConfigurations(${JSON.stringify(configurations)}); writeFileSync(${JSON.stringify(results)},JSON.stringify(results,null,2)+'\\n');\n`,
  );
  nodeCommand(configurations.root, ['--import', pathToFileURL(bootstrap).href, entry]);
  const measured = await reconcileNativeCapture(configurations, raw);
  writeFileSync(join(output, 'reconciliation.json'), `${JSON.stringify(measured, null, 2)}\n`);
  if (measured.status !== 'Pass')
    throw new Error('Native configuration capture failed qualification.');
  return {
    ...captureCoverage(snapshot, measured.maps, 'configs'),
    nativeEvidence: { acceptedExecutions: measured.processes, rejected: [] },
  };
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
