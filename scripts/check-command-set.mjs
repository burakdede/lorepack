#!/usr/bin/env node
/**
 * Asserts that the built binary still lists every command Phase 1 ships.
 *
 * A command that quietly stops being registered is exactly the regression prose cannot
 * catch: the code still compiles, the tests for its internals still pass, and only a user
 * discovers it is gone. Running the real `--help` is the cheapest way to notice.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(root, 'packages', 'cli', 'dist', 'entry.js');

const EXPECTED = [
  'init',
  'plan',
  'build',
  'status',
  'search',
  'diff',
  'builds',
  'activate',
  'rollback',
  'prune',
  'inspect',
  'pack',
];

if (!existsSync(binary)) {
  console.error(`check:command-set: ${binary} is missing. Run \`pnpm build\` first.`);
  process.exit(1);
}

const { stdout } = await execute(process.execPath, [binary, '--help'], { timeout: 60_000 });
const listed = new Set(
  stdout
    .split('\n')
    .map((line) => /^\s{2,}([a-z][a-z-]*)\s/.exec(line)?.[1])
    .filter((name) => name !== undefined),
);

const missing = EXPECTED.filter((name) => !listed.has(name));
if (missing.length > 0) {
  console.error(`check:command-set: \`lore --help\` does not list: ${missing.join(', ')}`);
  console.error('\nA command was removed or failed to register. Full help output:\n');
  console.error(stdout);
  process.exit(1);
}

console.log(`check:command-set: all ${EXPECTED.length} commands are registered`);
