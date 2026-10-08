import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
const NPM = process.env.NPM_COMMAND ?? 'npm';

export function discoverPublishablePackages(root = ROOT) {
  return readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, 'packages', entry.name))
    .sort()
    .map((directory) => ({
      directory,
      ...JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')),
    }))
    .filter((packageJson) => !packageJson.private);
}

export function runNpm(args, cwd) {
  const result = spawnSync(NPM, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return result;
}

export function packageExists(packageJson, npm = runNpm) {
  const result = npm(['view', packageJson.name, 'name', '--json'], packageJson.directory);
  if (result.status === 0) return true;

  const output = `${result.stdout}\n${result.stderr}`;
  if (/E404|404 Not Found|is not in this registry|No match found/i.test(output)) return false;
  throw new Error(`npm view failed for ${packageJson.name}: ${output.trim()}`);
}

export function findMissingPackages(packages, npm = runNpm) {
  return packages.filter((packageJson) => !packageExists(packageJson, npm));
}
