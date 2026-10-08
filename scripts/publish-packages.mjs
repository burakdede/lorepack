#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const NPM = process.env.NPM_COMMAND ?? 'npm';
const tag = parseTag(process.argv.slice(2));

function parseTag(args) {
  if (args.length !== 2 || args[0] !== '--tag' || !args[1]) {
    throw new Error('usage: publish-packages.mjs --tag <npm-dist-tag>');
  }
  return args[1];
}

function runNpm(args, cwd) {
  const result = spawnSync(NPM, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return result;
}

function isPublished(name, version, cwd) {
  const result = runNpm(['view', `${name}@${version}`, 'version', '--json'], cwd);
  if (result.status === 0) return result.stdout.trim().replace(/^"|"$/g, '') === version;

  const output = `${result.stdout}\n${result.stderr}`;
  if (/E404|404 Not Found|is not in this registry|No match found/i.test(output)) return false;
  throw new Error(`npm view failed for ${name}@${version}: ${output.trim()}`);
}

const packageDirs = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(ROOT, 'packages', entry.name))
  .sort();

for (const packageDir of packageDirs) {
  const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  if (packageJson.private) continue;

  const { name, version } = packageJson;
  if (isPublished(name, version, packageDir)) {
    console.log(`skipping ${name}@${version}: already published`);
    continue;
  }

  const result = runNpm(
    ['publish', '--access', 'public', '--tag', tag],
    packageDir,
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (/cannot publish over the previously published version/i.test(output)) {
      console.log(`skipping ${name}@${version}: already published`);
      continue;
    }
    throw new Error(`npm publish failed for ${name}@${version}`);
  }
}
