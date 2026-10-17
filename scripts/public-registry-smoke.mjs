#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
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

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
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

export function runSmoke(expectedVersion) {
  let entry = process.env.LOREPACK_SMOKE_CLI;
  if (!entry) {
    const installed = readGlobalInstall();
    assertInstalledVersion(installed.version, expectedVersion);
    entry = installed.entry;
  }
  const runLore = (args, cwd) => run(process.execPath, [entry, '--cwd', cwd, ...args], cwd);
  const jsonCommand = (args, cwd) => JSON.parse(assertCommandSucceeded(runLore(args, cwd), args));
  const project = mkdtempSync(join(tmpdir(), 'lorepack-public-smoke-'));
  const source = join(project, 'runbook.md');
  const archive = join(project, 'smoke.lorepack');

  try {
    writeFileSync(source, '# Rollback\n\nRun the rollback procedure after a failed deploy.\n');
    assertCommandSucceeded(runLore(['init'], project), ['lorepack', 'init']);
    assertCommandSucceeded(runLore(['build'], project), ['lorepack', 'build']);
    const firstBuild = jsonCommand(['status', '--json'], project).activeBuildId;
    if (!firstBuild) throw new Error('public registry smoke has no active build');

    assertSearchResult(jsonCommand(['search', 'rollback', '--json'], project));
    assertExportResult(
      jsonCommand(
        ['export', '--task', 'How should a failed deploy recover?', '--format', 'json'],
        project,
      ),
    );
    assertCommandSucceeded(runLore(['plan', '--json'], project), ['lorepack', 'plan', '--json']);

    writeFileSync(
      source,
      '# Rollback\n\nRun the rollback procedure after a failed deploy.\n\nKeep the receipt.\n',
    );
    assertCommandSucceeded(runLore(['build'], project), ['lorepack', 'build']);
    const secondBuild = jsonCommand(['status', '--json'], project).activeBuildId;
    if (!secondBuild || secondBuild === firstBuild)
      throw new Error('source edit did not create a new build');
    assertCommandSucceeded(runLore(['diff', firstBuild, secondBuild], project), [
      'lorepack',
      'diff',
      firstBuild,
      secondBuild,
    ]);
    assertCommandSucceeded(runLore(['pack', '--out', archive], project), ['lorepack', 'pack']);
    assertCommandSucceeded(runLore(['pack', '--verify', archive], project), [
      'lorepack',
      'pack',
      '--verify',
    ]);
    assertCommandSucceeded(runLore(['serve', '--help'], project), ['lorepack', 'serve', '--help']);
    assertCommandSucceeded(runLore(['mcp', '--help'], project), ['lorepack', 'mcp', '--help']);
    console.log(
      `public registry smoke passed: ${expectedVersion} on ${process.platform} ${process.arch}`,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    runSmoke(parseReleaseVersion(process.argv[2] ?? ''));
  } catch (error) {
    console.error(`public registry smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}
