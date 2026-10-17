#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
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

export function checkGlobalSmoke(outDir) {
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
    const tarball = packCli({ outDir });
    proof.tarball = tarball;
    proof.tarballSha256 = digest(readFileSync(tarball));
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
    proof.stage = 'running unchanged public smoke';
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/public-registry-smoke.mjs'), installed.version],
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
  if (process.argv[2] !== '--out' || !process.argv[3] || process.argv.length !== 4) {
    console.error('usage: check-global-smoke.mjs --out <directory>');
    process.exitCode = 1;
  } else {
    try {
      process.exitCode = checkGlobalSmoke(resolve(process.argv[3]));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
