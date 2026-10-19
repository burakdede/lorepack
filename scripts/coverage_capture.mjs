import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
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
  registerCampaignCapture,
} from './coverage_instrumented.mjs';
import { captureCoverage } from './coverage_report.mjs';

export function nodeCommand(root, args, environment = {}) {
  execFileSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...environment },
  });
}

const VERIFICATION_COMMANDS = [
  ...[
    'check-no-native',
    'check-no-em-dash',
    'check-public-branding',
    'check-no-conflict-claims',
    'check-counted-nouns',
    'check-command-set',
    'check-studio-bundle',
    'check-sources-tracked',
    'check-docs-images',
    'check-docs-links',
    'check-templates',
    'check-license-policy',
    'check-release-policy',
    'check-performance-report',
    'check-verify-parity',
  ].map((name) => `scripts/${name}.mjs`),
  { script: 'scripts/generate-schemas.mjs', args: ['--check'] },
  { script: 'scripts/generate-cli-reference.mjs', args: ['--check'] },
  { script: 'scripts/generate-acceptance-doc.mjs', args: ['--check'] },
  { script: 'scripts/demo-readme.mjs', args: ['--check'] },
  { script: 'scripts/probe-fts5.mjs', args: [] },
];

const CAMPAIGN_SUITES = [
  { name: 'default', config: 'vitest.config.ts', projects: null, root: null },
  {
    name: 'acceptance',
    config: 'tools/acceptance/vitest.config.ts',
    projects: ['tools/acceptance'],
    root: 'tools/acceptance',
  },
  {
    name: 'security',
    config: 'tools/security/vitest.config.ts',
    projects: ['tools/security'],
    root: 'tools/security',
  },
];
const BUNDLE_KINDS = ['configs', 'direct', 'children'];

export function assertNineCampaignBundles(snapshot, bundles, receipts) {
  if (typeof snapshot.candidate !== 'string' || !snapshot.candidate || snapshot.dirty !== false)
    throw new Error('Nine-suite qualification requires one clean candidate.');
  if (bundles.length !== 9 || receipts.length !== 3)
    throw new Error('Nine-suite qualification requires three complete suite receipts.');
  const expected = new Set(
    CAMPAIGN_SUITES.flatMap((suite) => BUNDLE_KINDS.map((kind) => `${suite.name}:${kind}`)),
  );
  const owned = new Map(snapshot.included.map((entry) => [entry.path, entry.sha256]));
  if (!owned.size || owned.size !== snapshot.included.length)
    throw new Error('Nine-suite inventory has missing or duplicate sources.');
  for (const receipt of receipts) {
    if (
      !CAMPAIGN_SUITES.some((suite) => suite.name === receipt.suite) ||
      receipt.candidate !== snapshot.candidate ||
      receipt.dirty !== false ||
      receipt.preparations !== 'Pass' ||
      receipt.collection !== 'Pass' ||
      !Number.isSafeInteger(receipt.files) ||
      receipt.files < 1 ||
      receipt.measurement !== 'Pass' ||
      receipt.children !== 'Pass'
    )
      throw new Error('Nine-suite preparation or execution receipt is missing.');
  }
  if (new Set(receipts.map((receipt) => receipt.suite)).size !== 3)
    throw new Error('Nine-suite receipts repeat or omit a suite.');
  for (const bundle of bundles) {
    if (!expected.delete(bundle.origin))
      throw new Error(`Duplicate or unexpected nine-suite origin: ${bundle.origin}`);
    if (
      bundle.schemaVersion !== 1 ||
      bundle.candidate !== snapshot.candidate ||
      bundle.dirty !== false ||
      !bundle.files ||
      typeof bundle.files !== 'object'
    )
      throw new Error(`Nine-suite candidate differs: ${bundle.origin}`);
    if (
      (bundle.origin.endsWith(':configs') || bundle.origin.endsWith(':children')) &&
      (!Number.isSafeInteger(bundle.nativeEvidence?.acceptedExecutions) ||
        bundle.nativeEvidence.acceptedExecutions < 0 ||
        !Array.isArray(bundle.nativeEvidence.rejected) ||
        bundle.nativeEvidence.rejected.length)
    )
      throw new Error(`Nine-suite native evidence differs: ${bundle.origin}`);
    for (const [path, record] of Object.entries(bundle.files))
      if (record?.sha256 !== owned.get(path) || !owned.has(path))
        throw new Error(`Nine-suite source differs: ${path}`);
  }
  if (expected.size) throw new Error(`Nine-suite origins are missing: ${[...expected].join(', ')}`);
}

export function assertCampaignPreparations(inventory, directory) {
  const owned = new Map(inventory.included.map((entry) => [entry.path, entry.sha256]));
  const preparedPaths = new Set();
  for (const file of readdirSync(directory)) {
    const prepared = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    if (owned.get(prepared.path) !== prepared.sha256 || preparedPaths.has(prepared.path))
      throw new Error(`Invalid executable preparation: ${prepared.path}`);
    preparedPaths.add(prepared.path);
  }
  const missing = inventory.included.filter((entry) => !preparedPaths.has(entry.path));
  if (missing.some((entry) => !/(?:vite|vitest)\.config\.ts$/.test(entry.path)))
    throw new Error('Campaign has missing executable preparations.');
  return {
    ...inventory,
    included: inventory.included.filter((entry) => preparedPaths.has(entry.path)),
  };
}

export async function captureVerificationCommands(
  snapshot,
  launch,
  commands = VERIFICATION_COMMANDS,
) {
  const root = realpathSync(snapshot.root);
  const invoke = (command) => {
    const script = typeof command === 'string' ? command : command.script;
    const args = typeof command === 'string' ? [] : command.args;
    const result = spawnSync(process.execPath, [join(root, script), ...args], {
      cwd: root,
      encoding: 'utf8',
    });
    return {
      script,
      args,
      code: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  const ordinary = commands.map((script) => {
    const result = invoke(script);
    if (result.code !== 0 || result.signal !== null)
      throw new Error(`Ordinary verification command failed: ${script}`);
    return result;
  });
  const capture = registerCampaignCapture(snapshot, launch);
  try {
    for (const expected of ordinary) {
      if (!isDeepStrictEqual(invoke(expected), expected))
        throw new Error(`Measured verification command differs: ${expected.script}`);
    }
    await capture.settled();
  } finally {
    capture.restore();
  }
  return {
    schemaVersion: 1,
    candidate: snapshot.candidate ?? null,
    status: 'Pass',
    commands: ordinary,
  };
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

export async function captureCampaign(root, output, pnpmEntrypoint, suite = 'default') {
  if (suite !== 'default' && suite !== 'all') throw new Error(`Unknown coverage suite: ${suite}`);
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
  if (suite === 'all' && (typeof inventory.candidate !== 'string' || inventory.dirty !== false))
    throw new Error('Nine-suite qualification requires one clean candidate.');
  const selected = suite === 'all' ? CAMPAIGN_SUITES : CAMPAIGN_SUITES.slice(0, 1);
  const configurations = await Promise.all(
    selected.map(async (entry) => {
      const { default: base } = await import(pathToFileURL(join(root, entry.config)).href);
      return { ...entry, base, projects: entry.projects ?? base.test.projects };
    }),
  );
  const preparations = join(output, 'preparations');
  for (const entry of configurations) {
    const suiteOutput = suite === 'all' ? join(output, entry.name) : output;
    mkdirSync(suiteOutput, { recursive: true });
    const preparationConfig = join(suiteOutput, 'preparation.config.mjs');
    writeFileSync(
      preparationConfig,
      renderCoverageConfig(
        sourceCoverageConfig(
          root,
          entry.projects,
          inventory,
          join(suiteOutput, 'preparation-direct'),
          '',
          entry.base.test,
        ),
        { snapshot: inventory, directory: preparations },
      ),
    );
    nodeCommand(root, [vitest, 'run', '--config', preparationConfig]);
  }
  const nativeSnapshot = assertCampaignPreparations(inventory, preparations);
  const native = join(output, 'native-preparations');
  await prepareNativeCapture(
    nativeSnapshot,
    preparations,
    native,
    '__LOREPACK_CAMPAIGN_COVERAGE__',
  );
  const bundles = [];
  const receipts = [];
  for (const entry of configurations) {
    const suiteOutput = suite === 'all' ? join(output, entry.name) : output;
    const built = await buildNativeCli(
      inventory,
      native,
      join(suiteOutput, 'measurement/dist'),
      '__LOREPACK_CAMPAIGN_COVERAGE__',
    );
    save(join(suiteOutput, 'native-build.json'), built);
    if (entry.name === 'default')
      save(
        join(output, 'verification.commands.json'),
        await captureVerificationCommands(inventory, built.launch),
      );
    const setup = join(suiteOutput, 'worker-setup.mjs');
    writeCampaignSetup(inventory, built.launch, setup);
    const configPath = join(suiteOutput, 'source.config.mjs');
    const directDirectory = join(suiteOutput, 'direct');
    writeFileSync(
      configPath,
      renderCoverageConfig(
        sourceCoverageConfig(
          root,
          entry.projects,
          inventory,
          directDirectory,
          setup,
          entry.base.test,
        ),
        { snapshot: inventory, directory: preparations },
      ),
    );
    const ordinary = join(suiteOutput, 'ordinary.files.json');
    const measured = join(suiteOutput, 'measured.files.json');
    const rootArgs = entry.root ? ['--root', entry.root] : [];
    nodeCommand(root, [vitest, 'list', ...rootArgs, '--filesOnly', `--json=${ordinary}`]);
    nodeCommand(root, [
      vitest,
      'list',
      '--config',
      configPath,
      '--filesOnly',
      `--json=${measured}`,
    ]);
    const parity = assertCollectionParity(json(ordinary), json(measured));
    save(join(suiteOutput, 'collection.parity.json'), parity);
    const prefix = suite === 'all' ? `${entry.name}:` : '';
    const configBundle = join(suiteOutput, 'configs.bundle.json');
    save(
      configBundle,
      await captureConfigurations(
        inventory,
        join(suiteOutput, 'configs-native'),
        `${prefix}configs`,
      ),
    );
    nodeCommand(root, [vitest, 'run', '--config', configPath]);
    const directMap = join(directDirectory, 'coverage-final.json');
    const directBundle = join(suiteOutput, 'direct.bundle.json');
    nodeCommand(root, [
      join(root, 'scripts/coverage_report.mjs'),
      '--capture',
      inventoryPath,
      '--map',
      directMap,
      '--origin',
      `${prefix}direct`,
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
    save(join(suiteOutput, 'children.reconciliation.json'), children);
    if (children.status !== 'Pass')
      throw new Error('Campaign native children failed qualification.');
    const childBundle = join(suiteOutput, 'children.bundle.json');
    save(childBundle, {
      ...captureCoverage(inventory, children.maps, `${prefix}children`),
      nativeEvidence: { acceptedExecutions: children.processes, rejected: [] },
    });
    bundles.push(configBundle, directBundle, childBundle);
    if (suite === 'all') {
      const receipt = {
        suite: entry.name,
        candidate: inventory.candidate,
        dirty: inventory.dirty,
        preparations: 'Pass',
        collection: parity.status,
        files: parity.files,
        measurement: 'Pass',
        children: children.status,
      };
      save(join(suiteOutput, 'suite.receipt.json'), receipt);
      receipts.push(receipt);
    }
  }
  if (suite === 'all') assertNineCampaignBundles(inventory, bundles.map(json), receipts);
  nodeCommand(root, [
    join(root, 'scripts/coverage_report.mjs'),
    ...bundles.flatMap((bundle) => ['--input', bundle]),
    '--out',
    join(output, 'report.json'),
  ]);
}

export async function captureConfigurations(snapshot, output, origin = 'configs') {
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
    ...captureCoverage(snapshot, measured.maps, origin),
    nativeEvidence: { acceptedExecutions: measured.processes, rejected: [] },
  };
}

if (import.meta.main) {
  try {
    const { values, tokens } = parseArgs({
      tokens: true,
      options: {
        out: { type: 'string' },
        suite: { type: 'string' },
        'import-configs': { type: 'string' },
        results: { type: 'string' },
      },
    });
    if (tokens.filter((token) => token.kind === 'option' && token.name === 'suite').length > 1)
      throw new Error('Select --suite only once.');
    if (values['import-configs'] && values.results && !values.out && !values.suite) {
      const snapshot = JSON.parse(readFileSync(values['import-configs'], 'utf8'));
      const imported = await importConfigurations(snapshot);
      writeFileSync(values.results, `${JSON.stringify(imported, null, 2)}\n`);
    } else if (values.out && !values['import-configs'] && !values.results) {
      await captureCampaign(
        realpathSync(join(import.meta.dirname, '..')),
        resolve(values.out),
        process.env.npm_execpath,
        values.suite ?? 'default',
      );
    } else
      throw new Error(
        'Use --out <fresh artifact directory> [--suite all], or --import-configs <inventory> --results <file>.',
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
