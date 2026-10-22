#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packCli, runTool } from './pack-cli.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * @param {string} prefix
 * @param {string} temporary
 * @param {NodeJS.ProcessEnv} environment
 * @returns {NodeJS.ProcessEnv}
 */
export function globalSmokeEnvironment(prefix, temporary, environment = process.env) {
  const env = { ...environment };
  for (const name of Object.keys(env)) {
    if (['path', 'npm_config_prefix', 'lorepack_smoke_cli'].includes(name.toLowerCase())) {
      delete env[name];
    }
  }
  const originalPath =
    Object.entries(environment).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? '';
  return {
    ...env,
    PATH: `${process.platform === 'win32' ? prefix : join(prefix, 'bin')}${delimiter}${originalPath}`,
    npm_config_prefix: prefix,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    LOREPACK_LITERAL: 'must remain literal',
  };
}

export function parseGlobalSmokeArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (
      !['--out', '--tarball'].includes(flag) ||
      values[flag] !== undefined ||
      !args[index + 1] ||
      args[index + 1].startsWith('--')
    ) {
      throw new Error('usage: check-global-smoke.mjs --out <directory> [--tarball <tgz>]');
    }
    values[flag] = resolve(args[index + 1]);
  }
  if (values['--out'] === undefined) throw new Error('--out is required');
  if (values['--tarball'] !== undefined) {
    const inside = relative(values['--out'], values['--tarball']);
    if (
      inside === '' ||
      (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))
    ) {
      throw new Error('supplied tarball must be outside the evidence directory');
    }
  }
  return { outDir: values['--out'], tarball: values['--tarball'] };
}

export function checkGlobalSmoke(outDir, { tarball: suppliedTarball } = {}) {
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'lorepack-global-smoke-'));
  const prefix = join(work, 'global prefix & (literal) ^ %LOREPACK_LITERAL%');
  const temporary = join(work, 'project space & (literal) ^ %LOREPACK_LITERAL%');
  mkdirSync(temporary);
  const env = globalSmokeEnvironment(prefix, temporary);
  const proof = {
    schema: 1,
    source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    node: process.versions,
    platform: process.platform,
    architecture: process.arch,
    prefix,
    temporary,
    smokeSha256: digest(readFileSync(join(ROOT, 'scripts/public-registry-smoke.mjs'))),
    verifierSha256: digest(readFileSync(import.meta.filename)),
    expectedVersion: JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8'))
      .version,
    stage: 'packing',
    exitCode: null,
  };
  let code = 1;
  try {
    const tarball = suppliedTarball ?? packCli({ outDir });
    proof.tarball = tarball;
    proof.tarballSha256 = digest(readFileSync(tarball));
    proof.tarballMode = suppliedTarball === undefined ? 'packed' : 'supplied';
    proof.stage = 'installing global tarball';
    runTool(
      'npm',
      ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
      ROOT,
      {
        env: { npm_config_prefix: prefix },
      },
    );
    const packageRoot =
      process.platform === 'win32'
        ? join(prefix, 'node_modules', '@lorepack', 'cli')
        : join(prefix, 'lib', 'node_modules', '@lorepack', 'cli');
    const manifest = readFileSync(join(packageRoot, 'package.json'));
    const installed = JSON.parse(manifest);
    proof.packageRoot = packageRoot;
    proof.version = installed.version;
    proof.installedGitHead = installed.gitHead;
    proof.installedManifestSha256 = digest(manifest);
    writeFileSync(join(outDir, 'installed-package.json'), manifest);
    if (installed.version !== proof.expectedVersion)
      throw new Error('Installed tarball version differs.');
    if (installed.gitHead !== proof.source) throw new Error('Installed tarball source differs.');
    proof.stage = 'running retained public lifecycle smoke';
    const result = spawnSync(
      process.execPath,
      [
        join(ROOT, 'scripts/public-registry-smoke.mjs'),
        installed.version,
        '--out',
        join(outDir, 'lifecycle'),
      ],
      {
        cwd: temporary,
        env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    writeFileSync(join(outDir, 'smoke.stdout'), result.stdout ?? '');
    writeFileSync(join(outDir, 'smoke.stderr'), result.stderr ?? '');
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    proof.tarballUnchanged = digest(readFileSync(tarball)) === proof.tarballSha256;
    if (!proof.tarballUnchanged) throw new Error('Tarball changed during global smoke.');
    proof.signal = result.signal;
    proof.launchError = result.error?.message ?? null;
    code = result.status ?? 1;
    proof.stage = code === 0 ? 'passed' : 'failed public smoke';
    return code;
  } catch (error) {
    proof.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    proof.exitCode = code;
    rmSync(work, { recursive: true, force: true });
    proof.cleaned = true;
    writeFileSync(join(outDir, 'result.json'), `${JSON.stringify(proof, null, 2)}\n`);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  try {
    const { outDir, tarball } = parseGlobalSmokeArgs(process.argv.slice(2));
    process.exitCode = checkGlobalSmoke(outDir, { tarball });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
