#!/usr/bin/env node
/**
 * Asserts that the built binary lists every command Phase 1 ships, and that no message it
 * can print names a command it does not have.
 *
 * A command that quietly stops being registered is exactly the regression prose cannot
 * catch: the code still compiles, the tests for its internals still pass, and only a user
 * discovers it is gone. Running the real `--help` is the cheapest way to notice.
 *
 * The second half is #168. Every error without an explicit remediation told the user to
 * "run `lore doctor` for diagnostics", and `lore doctor` is Phase 3. The advice was
 * confidently wrong, and a unit test asserted it, so nothing was going to catch it except a
 * person typing the command.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(root, 'packages', 'cli', 'dist', 'entry.js');

const EXPECTED = [
  'init',
  // Phase 3 adds its commands here as they land, so `--help` losing one is a failed build
  // rather than a discovery. `doctor`, `config` and `connect` follow with #56, #57 and #58.
  'dev',
  'doctor',
  'config',
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
  'mcp',
  'serve',
  'export',
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

/**
 * Commands named in source strings, which is where remediations live.
 *
 * Deliberately literal: `` `lore <word>` `` inside a backtick-quoted phrase is how every
 * remediation in the codebase refers to a command, so matching that shape finds them
 * without needing to understand the sentence around it.
 */
const REFERENCE = /`lore ([a-z][a-z-]*)/g;
const SEARCHED = /^packages\/[^/]+\/src\/.*\.ts$/;
/** Not commands: `lore.yaml` and friends, and the global flags. */
const NOT_A_COMMAND = new Set(['yaml', 'lock', 'json', 'help', 'version']);

const sources = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: root })
  .split('\n')
  .filter((file) => SEARCHED.test(file));

const unknown = [];
for (const file of sources) {
  const text = readFileSync(join(root, file), 'utf8');
  text.split('\n').forEach((line, index) => {
    // Comments discuss commands from later phases by name, which is documentation rather
    // than a promise made to a user mid-failure. Stripping them can also swallow a `//`
    // inside a string, which costs a missed reference and never a false accusation.
    const code = line
      .replace(/\/\*.*?\*\//g, '')
      .replace(/\/\/.*$/, '')
      .replace(/^\s*\*.*$/, '');
    for (const [, name] of code.matchAll(REFERENCE)) {
      if (listed.has(name) || NOT_A_COMMAND.has(name)) continue;
      unknown.push(`${file}:${index + 1}: \`lore ${name}\``);
    }
  });
}

if (unknown.length > 0) {
  console.error(
    `check:command-set: ${unknown.length} message(s) name a command that does not exist.`,
  );
  console.error('A remediation that points at a missing command is worse than none.\n');
  for (const reference of unknown) console.error(`  ${reference}`);
  process.exit(1);
}

console.log(`check:command-set: ${sources.length} source files reference only registered commands`);
