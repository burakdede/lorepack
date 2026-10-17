import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const EXECUTABLE = /\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/;
const TEST = /(^|\/)(test|tests|fixtures|__tests__)\/|\.(test|spec)\.[^/]+$/;
const CRITICAL =
  /(core\/src\/(hash|paths|sql|runtime)|compiler\/src\/(discover|seal|lock|fingerprint)|backend-local\/src\/(archive|atomic|object-store|state-store|runtime-backend|lock|sql)|runtime\/src\/(context|read-source|runtime|http)|cli\/src\/(services\/(build|retention|packing|builds|serving)|commands\/activate)|parsers\/src\/resident_memory\.ts$|mcp\/src\/(http|protocol)|deploy-cloudflare\/src\/(access-auth|runtime-auth|retention|projection-state|projection-preflight))/;

export function classifySource(path) {
  if (!EXECUTABLE.test(path)) return null;
  let reason = null;
  if (path.endsWith('.d.ts')) reason = 'nonexecuted declaration';
  else if (TEST.test(path)) reason = 'test or fixture code, not production';
  else if (path.startsWith('tools/test-support/') || path.startsWith('tools/studio-e2e/'))
    reason = 'test-only support/harness';
  else if (path.startsWith('.specify/')) reason = 'generated specification tooling';
  return {
    reason,
    critical: CRITICAL.test(path),
    group: /^(packages|apps|tools)\//.test(path) ? path.split('/')[1] : path.split('/')[0],
  };
}

function assertPath(path) {
  if (
    typeof path !== 'string' ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Invalid owned source path: ${String(path)}`);
}

export function readFrozenInventory(path) {
  const frozen = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !Array.isArray(frozen.included) ||
    frozen.included.length !== 345 ||
    frozen.included.filter((entry) => entry.critical === true).length !== 49
  )
    throw new Error('The frozen audit inventory must retain 345 owned and 49 critical files.');
  const digest = createHash('sha256').update(JSON.stringify(frozen.included)).digest('hex');
  if (
    frozen.candidate !== '7141e61a3ead8ab935a1f4dbb59f0db6c2951efb' ||
    digest !== '8a4cecd1d816a87f515a9fd13d0edb7f08b0a0ba37a49f4c744b8f7088576a46'
  )
    throw new Error('The frozen source records differ from the retained 7141e61 audit.');
  return frozen;
}

export function coverageInventory(root, frozen) {
  const preserved = new Map();
  for (const entry of frozen.included) {
    assertPath(entry.path);
    const classification = classifySource(entry.path);
    if (
      !classification ||
      classification.reason ||
      typeof entry.critical !== 'boolean' ||
      preserved.has(entry.path)
    )
      throw new Error(`Invalid frozen source record: ${entry.path}`);
    preserved.set(entry.path, entry);
  }
  const gitPaths = (args) =>
    execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  const tracked = [...new Set(gitPaths([]))].sort();
  const trackedSet = new Set(tracked);
  const missing = [...preserved.keys()].filter((path) => !trackedSet.has(path));
  if (missing.length) throw new Error(`Frozen owned sources are missing: ${missing.join(', ')}`);
  const untracked = gitPaths(['--others', '--exclude-standard']).filter((path) => {
    const classification = classifySource(path);
    return classification && !classification.reason;
  });
  if (untracked.length)
    throw new Error(`Owned sources must be tracked: ${untracked.sort().join(', ')}`);
  const included = [];
  const excluded = [];
  for (const path of tracked) {
    const classification = classifySource(path);
    if (!classification) continue;
    assertPath(path);
    const absolute = join(root, ...path.split('/'));
    const stat = lstatSync(absolute);
    if (!stat.isFile()) throw new Error(`Executable source is not a regular file: ${path}`);
    const sha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    if (classification.reason) excluded.push({ path, sha256, reason: classification.reason });
    else
      included.push({
        path,
        sha256,
        critical: preserved.has(path) ? preserved.get(path).critical : classification.critical,
        group: classification.group,
        frozen: preserved.has(path),
      });
  }
  return {
    frozenOwned: preserved.size,
    frozenCritical: [...preserved.values()].filter((entry) => entry.critical).length,
    included,
    excluded,
  };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out' || !args[1]))
      throw new Error('Usage: node scripts/coverage_inventory.mjs [--out <file>]');
    const root = join(import.meta.dirname, '..');
    const frozen = readFrozenInventory(
      join(root, 'tools/coverage_inventory/frozen_inventory.json'),
    );
    const inventory = {
      ...coverageInventory(root, frozen),
      root: realpathSync(root),
      candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty:
        execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).length > 0,
    };
    const json = `${JSON.stringify(inventory, null, 2)}\n`;
    if (args[1]) {
      const output = resolve(root, args[1]);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, json);
      console.log(
        `coverage inventory: ${inventory.included.length} owned, ${inventory.included.filter((entry) => entry.critical).length} critical; frozen ${inventory.frozenOwned}/${inventory.frozenCritical}`,
      );
    } else process.stdout.write(json);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
