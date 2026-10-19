#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseReleaseVersion(value) {
  const version = value.trim().replace(/^v/, '');
  if (!VERSION_PATTERN.test(version)) throw new Error(`invalid release version: ${value}`);
  return version;
}

export function assertInstalledVersion(actual, expected) {
  if (actual !== expected) {
    throw new Error(`installed CLI version ${actual} does not match requested ${expected}`);
  }
}

export function assertCommandSucceeded(result, command) {
  if (result.status !== 0) {
    throw new Error(
      `${command.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`.trim(),
    );
  }
  return result.stdout;
}

export function assertSearchResult(payload) {
  if (!Array.isArray(payload.hits) || payload.hits.length === 0) {
    throw new Error('public registry smoke search returned no hits');
  }
  for (const hit of payload.hits) {
    if (!hit.locator?.relativePath || !hit.locator?.artifactId) {
      throw new Error('public registry smoke search returned a hit without complete provenance');
    }
  }
}

export function assertExportResult(payload) {
  if (!payload.buildId || !Array.isArray(payload.citations) || payload.citations.length === 0) {
    throw new Error('public registry smoke export returned no cited context');
  }
  for (const citation of payload.citations) {
    if (!citation.relativePath) throw new Error('public registry smoke export lost provenance');
  }
}

export function runSmokeCommand(command, args, cwd, evidence) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  const record = {
    command,
    args,
    cwd,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.status ?? 1,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
  if (evidence !== undefined) writeFileSync(evidence, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function readInstalledCli(globalRoot) {
  const packageRoot = resolve(globalRoot, '@lorepack', 'cli');
  const manifest = join(packageRoot, 'package.json');
  if (!existsSync(manifest)) throw new Error(`global CLI package is missing at ${manifest}`);
  const installed = JSON.parse(readFileSync(manifest, 'utf8'));
  const binary = installed.bin?.lorepack;
  if (typeof binary !== 'string' || binary === '') {
    throw new Error('global CLI package has no lorepack entry');
  }
  const entry = resolve(packageRoot, binary);
  if (!entry.startsWith(`${packageRoot}${sep}`) || !existsSync(entry)) {
    throw new Error('global CLI entry is missing or outside its package');
  }
  if (
    !statSync(entry).isFile() ||
    !realpathSync(entry).startsWith(`${realpathSync(packageRoot)}${sep}`)
  ) {
    throw new Error('global CLI entry is missing or outside its package');
  }
  return { version: installed.version, entry };
}

function readGlobalInstall() {
  const args = ['root', '--global'];
  const globalRoot =
    process.platform === 'win32'
      ? execFileSync(
          process.execPath,
          [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args],
          { encoding: 'utf8' },
        ).trim()
      : execFileSync('npm', args, { encoding: 'utf8' }).trim();
  return readInstalledCli(globalRoot);
}

const CONFIG = 'version: 1\nname: global-release-proof\nsources: [docs]\n';
const FIRST = '# Rollback\n\nRun the rollback procedure after a failed deploy.\n';
const SECOND = `${FIRST}\nKeep the receipt.\n`;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function runSmoke(expectedVersion, { outDir } = {}) {
  let entry = process.env.LOREPACK_SMOKE_CLI;
  if (!entry) {
    const installed = readGlobalInstall();
    assertInstalledVersion(installed.version, expectedVersion);
    entry = installed.entry;
  }
  if (outDir !== undefined) mkdirSync(outDir, { recursive: true });
  const project = mkdtempSync(join(tmpdir(), 'lorepack-public-smoke-'));
  const source = join(project, 'docs', 'runbook.md');
  const archive = join(project, 'smoke.lorepack');
  const proof = {
    schema: 1,
    expectedVersion,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    entry,
    invocation: 'installed-node-entry',
    commands: [],
    fixtures: {},
    passed: false,
  };
  const runLore = (args) => {
    const name = `${String(proof.commands.length + 1).padStart(2, '0')}-${args[0]}.json`;
    proof.commands.push(name);
    return runSmokeCommand(
      process.execPath,
      [entry, '--cwd', project, ...args],
      project,
      outDir === undefined ? undefined : join(outDir, name),
    );
  };
  const command = (args) => assertCommandSucceeded(runLore(args), args);
  const jsonCommand = (args) => JSON.parse(command([...args, '--json']));
  const fixture = (revision) => {
    proof.fixtures[revision] = Object.fromEntries(
      ['lore.yaml', 'docs/runbook.md', 'lore.lock']
        .filter((path) => existsSync(join(project, path)))
        .map((path) => {
          const bytes = readFileSync(join(project, path));
          return [
            path,
            { sha256: digest(bytes), bytes: bytes.length, content: bytes.toString('utf8') },
          ];
        }),
    );
  };
  const validate = (id) => {
    const result = jsonCommand(['validate', '--build', id]);
    assert(
      result.buildId === id && result.ok === true && result.mode === 'existing-build',
      'retained validation did not verify the requested build',
    );
  };
  const search = (id) => {
    const result = jsonCommand(['search', 'rollback']);
    assertSearchResult(result);
    assert(result.buildId === id, 'search did not read the expected active build');
  };
  try {
    command(['init']);
    mkdirSync(join(project, 'docs'), { recursive: true });
    writeFileSync(join(project, 'lore.yaml'), CONFIG);
    writeFileSync(source, FIRST);
    fixture('beforeA');
    const planA = jsonCommand(['plan']);
    assert(planA.artifacts.added === 1, 'initial plan did not identify the canonical source');
    const builtA = jsonCommand(['build']);
    const firstBuild = jsonCommand(['status']).activeBuildId;
    assert(
      typeof firstBuild === 'string' &&
        firstBuild.length > 0 &&
        builtA.buildId === firstBuild &&
        builtA.activated === true,
      'initial build was not activated',
    );
    proof.buildA = firstBuild;
    fixture('A');
    validate(firstBuild);
    const manifestA = jsonCommand(['inspect', 'build', firstBuild]);
    assert(
      manifestA.buildId === firstBuild && manifestA.projectName === 'global-release-proof',
      'inspection did not return the canonical initial build',
    );
    const sources = jsonCommand(['inspect', 'sources']);
    assert(
      sources.buildId === firstBuild &&
        sources.artifacts.length === 1 &&
        sources.artifacts[0].displayPath === 'docs/runbook.md',
      'source inspection lost the fixture',
    );
    search(firstBuild);
    const exported = JSON.parse(
      command(['export', '--task', 'How should a failed deploy recover?', '--format', 'json']),
    );
    assertExportResult(exported);
    assert(exported.buildId === firstBuild, 'export did not read the expected active build');

    writeFileSync(source, SECOND);
    const planB = jsonCommand(['plan']);
    assert(
      planB.artifacts.changed === 1 && planB.artifacts.added === 0 && planB.artifacts.removed === 0,
      'edited plan did not identify the changed source',
    );
    const builtB = jsonCommand(['build', '--no-activate']);
    const secondBuild = builtB.buildId;
    assert(
      typeof secondBuild === 'string' &&
        secondBuild.length > 0 &&
        secondBuild !== firstBuild &&
        builtB.activated === false,
      'edited candidate was not a distinct inactive build',
    );
    proof.buildB = secondBuild;
    fixture('B');
    assert(
      jsonCommand(['status']).activeBuildId === firstBuild,
      'candidate build changed the active pointer',
    );
    validate(secondBuild);
    assert(
      jsonCommand(['activate', secondBuild]).buildId === secondBuild,
      'activation returned the wrong build',
    );
    assert(
      jsonCommand(['status']).activeBuildId === secondBuild,
      'activation did not move the pointer',
    );
    assert(
      jsonCommand(['inspect', 'build', secondBuild]).buildId === secondBuild,
      'inspection returned the wrong candidate',
    );
    const diff = jsonCommand(['diff', firstBuild, secondBuild]);
    assert(
      diff.from === firstBuild &&
        diff.to === secondBuild &&
        diff.identical === false &&
        diff.artifacts.changed === 1 &&
        diff.artifacts.changes.some(
          (change) => change.path === 'runbook.md' && change.change === 'changed',
        ),
      'diff lost the source edit',
    );
    command(['pack', '--out', archive]);
    command(['pack', '--verify', archive]);
    const inventory = jsonCommand(['builds'])
      .builds.map((build) => build.buildId)
      .sort();
    assert.deepEqual(inventory, [firstBuild, secondBuild].sort(), 'unexpected build inventory');
    const sealed = new Map(
      [firstBuild, secondBuild].map((id) => [
        id,
        readFileSync(join(project, '.lore', 'builds', id, 'manifest.json')),
      ]),
    );
    rmSync(join(project, 'docs'), { recursive: true });
    validate(secondBuild);
    search(secondBuild);
    assert(
      jsonCommand(['rollback', firstBuild]).buildId === firstBuild,
      'rollback returned the wrong build',
    );
    assert(
      jsonCommand(['builds']).activeBuildId === firstBuild,
      'rollback did not restore the initial pointer',
    );
    search(firstBuild);
    for (const [id, bytes] of sealed)
      assert(
        bytes.equals(readFileSync(join(project, '.lore', 'builds', id, 'manifest.json'))),
        'rollback changed a sealed manifest',
      );
    assert.deepEqual(
      jsonCommand(['builds'])
        .builds.map((build) => build.buildId)
        .sort(),
      inventory,
      'rollback changed the build inventory',
    );
    proof.rolledBackTo = firstBuild;
    command(['serve', '--help']);
    command(['mcp', '--help']);
    proof.passed = true;
    console.log(
      `public registry smoke passed: ${expectedVersion} on ${process.platform} ${process.arch}`,
    );
    return proof;
  } catch (error) {
    proof.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    try {
      rmSync(project, { recursive: true, force: true });
      proof.cleaned = true;
    } finally {
      if (outDir !== undefined)
        writeFileSync(join(outDir, 'lifecycle.json'), `${JSON.stringify(proof, null, 2)}\n`);
    }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (process.argv.length !== 3 && !(process.argv.length === 5 && process.argv[3] === '--out')) {
      throw new Error('usage: public-registry-smoke.mjs <version> [--out <directory>]');
    }
    runSmoke(
      parseReleaseVersion(process.argv[2] ?? ''),
      process.argv[4] === undefined ? {} : { outDir: resolve(process.argv[4]) },
    );
  } catch (error) {
    console.error(`public registry smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}
