#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function loreCommand() {
  return process.platform === 'win32' ? 'lore.cmd' : 'lore';
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

function runLore(args, cwd) {
  const localEntry = process.env.LOREPACK_SMOKE_CLI;
  if (localEntry) return run(process.execPath, [localEntry, '--cwd', cwd, ...args], cwd);
  return run(loreCommand(), ['--cwd', cwd, ...args], cwd);
}

function readInstalledVersion() {
  const globalRoot = execFileSync(npmCommand(), ['root', '--global'], { encoding: 'utf8' }).trim();
  const manifest = join(globalRoot, '@lorepack', 'cli', 'package.json');
  if (!existsSync(manifest)) throw new Error(`global CLI package is missing at ${manifest}`);
  return JSON.parse(readFileSync(manifest, 'utf8')).version;
}

function jsonCommand(args, cwd) {
  return JSON.parse(assertCommandSucceeded(runLore(args, cwd), args));
}

export function runSmoke(expectedVersion) {
  if (!process.env.LOREPACK_SMOKE_CLI) {
    assertInstalledVersion(readInstalledVersion(), expectedVersion);
  }
  const project = mkdtempSync(join(tmpdir(), 'lorepack-public-smoke-'));
  const source = join(project, 'runbook.md');
  const archive = join(project, 'smoke.lorepack');

  try {
    writeFileSync(source, '# Rollback\n\nRun the rollback procedure after a failed deploy.\n');
    assertCommandSucceeded(runLore(['init'], project), ['lore', 'init']);
    assertCommandSucceeded(runLore(['build'], project), ['lore', 'build']);
    const firstBuild = jsonCommand(['status', '--json'], project).activeBuildId;
    if (!firstBuild) throw new Error('public registry smoke has no active build');

    assertSearchResult(jsonCommand(['search', 'rollback', '--json'], project));
    assertExportResult(
      jsonCommand(
        ['export', '--task', 'How should a failed deploy recover?', '--format', 'json'],
        project,
      ),
    );
    assertCommandSucceeded(runLore(['plan', '--json'], project), ['lore', 'plan', '--json']);

    writeFileSync(
      source,
      '# Rollback\n\nRun the rollback procedure after a failed deploy.\n\nKeep the receipt.\n',
    );
    assertCommandSucceeded(runLore(['build'], project), ['lore', 'build']);
    const secondBuild = jsonCommand(['status', '--json'], project).activeBuildId;
    if (!secondBuild || secondBuild === firstBuild)
      throw new Error('source edit did not create a new build');
    assertCommandSucceeded(runLore(['diff', firstBuild, secondBuild], project), [
      'lore',
      'diff',
      firstBuild,
      secondBuild,
    ]);
    assertCommandSucceeded(runLore(['pack', '--out', archive], project), ['lore', 'pack']);
    assertCommandSucceeded(runLore(['pack', '--verify', archive], project), [
      'lore',
      'pack',
      '--verify',
    ]);
    assertCommandSucceeded(runLore(['serve', '--help'], project), ['lore', 'serve', '--help']);
    assertCommandSucceeded(runLore(['mcp', '--help'], project), ['lore', 'mcp', '--help']);
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
