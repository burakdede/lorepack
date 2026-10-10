import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './support/evidence.js';

/**
 * Every place a test can stop running, and why it may.
 *
 * Biome's `noSkippedTests` and `noFocusedTests` reject a literal `it.skip(...)` or
 * `it.only(...)`, but not `it.skipIf(...)`, `it.runIf(...)`, `it.todo(...)`, a run-time
 * `context.skip()`, or `it.skip` used as a value. Each of those is how a platform skip is
 * written, so each is legitimate somewhere, and each would hide a security test as well
 * as a `.skip` would (#615). This is the written allow-list: a new one is a reviewed line
 * in this file, not a side effect.
 *
 * Keyed by file and the exact trimmed source line, so changing the condition is a change
 * here too.
 */
const ALLOWED: readonly { readonly file: string; readonly line: string; readonly why: string }[] = [
  {
    file: 'packages/cli/test/build.test.ts',
    line: 'it.skipIf(posixOnly)(',
    why: 'chmod is POSIX; Windows needs an ACL API Node does not expose',
  },
  {
    file: 'packages/cli/test/build.test.ts',
    line: "it.skipIf(posixOnly)('builds normally once the permission is fixed', async () => {",
    why: 'chmod is POSIX; Windows needs an ACL API Node does not expose',
  },
  {
    file: 'packages/cli/test/connect.test.ts',
    line: "it.skipIf(process.platform === 'win32')(",
    why: 'a symbolic link on Windows needs administrator rights or Developer Mode',
  },
  {
    file: 'packages/cli/test/dev.e2e.test.ts',
    line: 'it.runIf(CAN_SIGNAL_GRACEFULLY)(',
    why: 'Windows has no catchable termination signal; a hard kill is covered instead',
  },
  {
    file: 'packages/cli/test/dev.e2e.test.ts',
    line: 'it.runIf(LAN_ADDRESS !== undefined)(',
    why: 'a machine with no non-loopback interface has no LAN address to bind or expose',
  },
  {
    file: 'packages/cli/test/windows.test.ts',
    line: "it.runIf(!WINDOWS && platform() !== 'darwin')(",
    why: 'a case-only collision exists only on a case-sensitive filesystem',
  },
  {
    file: 'packages/cli/test/windows.test.ts',
    line: "it.runIf(WINDOWS)('is a long path, not an 8.3 short one', () => {",
    why: '8.3 short names exist only on Windows',
  },
  {
    file: 'packages/connect-clients/test/config-file.test.ts',
    line: "const posixOnly = it.skipIf(process.platform === 'win32');",
    why: 'POSIX modes are not meaningful on Windows, and links need administrator rights',
  },
  {
    file: 'packages/connect-clients/test/contract.ts',
    line: "const posixOnly = process.platform === 'win32' ? it.skip : it;",
    why: 'on Windows chmod only toggles the read-only flag',
  },
  {
    file: 'packages/connect-clients/test/contract.ts',
    line: "const symlinkOnly = process.platform === 'win32' ? it.skip : it;",
    why: 'a symbolic link on Windows needs administrator rights or Developer Mode',
  },
  {
    file: 'packages/core/test/config.test.ts',
    line: "it.skipIf(platform() === 'win32')(",
    why: 'mkfifo has no Windows equivalent inside a project directory',
  },
  {
    file: 'tools/acceptance/test/acceptance.test.ts',
    line: `it.skipIf(skippedHere(scenario))(\`\${scenario.id}: \${scenario.title}\`, async () => {`,
    why: 'per-scenario platform skips, each with a reason the catalogue test requires',
  },
  {
    file: 'tools/acceptance/test/cloudflare-smoke.test.ts',
    line: 'it.skipIf(missing.length > 0)(',
    why: 'needs Cloudflare credentials; the credentialed CI job runs it',
  },
  {
    file: 'tools/acceptance/test/cloudflare-testing.test.ts',
    line: 'it.skipIf(missing.length > 0)(',
    why: 'needs Cloudflare credentials; the credentialed CI job runs it',
  },
  {
    file: 'tools/acceptance/test/runner.test.ts',
    line: "it.skipIf(process.platform === 'win32')('delivers a real signal to a real process', async () => {",
    why: 'Windows cannot deliver a catchable POSIX signal to a child',
  },
  {
    file: 'tools/acceptance/test/runner.test.ts',
    line: "it.skipIf(process.platform === 'win32')(",
    why: 'Windows cannot deliver a catchable POSIX signal to a child',
  },
  {
    file: 'tools/security/test/privacy-defaults.test.ts',
    line: "describe.runIf(IN_NETWORK_NAMESPACE)('inside a network namespace, issue 616', () => {",
    why: 'needs root to create the namespace; the Linux privacy sandbox CI job runs it',
  },
  {
    file: 'tools/test-support/src/runtime-contract.ts',
    line: 'it.skipIf(activate === undefined)(',
    why: 'a backend that cannot activate another build in a test declares so in its options',
  },
  {
    file: 'tools/security/test/fixtures/skipped/gate.fixture.ts',
    line: "describe.skip('a source read cannot escape the build', () => {",
    why: 'fixture proving the security gate rejects a skipped test',
  },
  {
    file: 'tools/security/test/fixtures/skipped/gate.fixture.ts',
    line: "it.skipIf(true)('is skipped by a condition', () => {",
    why: 'fixture proving the security gate rejects a conditional skip',
  },
  {
    file: 'tools/security/test/fixtures/skipped/gate.fixture.ts',
    line: "it.todo('is only a todo');",
    why: 'fixture proving the security gate rejects a todo',
  },
  {
    file: 'tools/security/test/fixtures/skipped/gate.fixture.ts',
    line: 'context.skip();',
    why: 'fixture proving the security gate rejects a run-time skip',
  },
];

const SKIP =
  /\b(?:it|test|describe|suite|bench)(?:\.(?:concurrent|sequential|each|for|shuffle))*\.(?:skip|only|todo|skipIf|runIf)\b|\b(?:ctx|context|task)\.skip\s*\(/;

const SELF = 'tools/security/test/test-skips.test.ts';

interface Site {
  readonly file: string;
  readonly line: string;
}

function sites(): readonly Site[] {
  const files = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '*.ts',
      '*.tsx',
      '*.mts',
      '*.js',
      '*.mjs',
      '*.cjs',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter((file) => file !== '' && file !== SELF);
  const found: Site[] = [];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
      if (SKIP.test(trimmed)) found.push({ file, line: trimmed });
    }
  }
  return found;
}

const key = (site: Site): string => `${site.file}: ${site.line}`;

describe('every way a test can stop running is on the written allow-list, issue 615', () => {
  const found = sites();

  it('finds no skip, focus, todo or conditional run that is not listed', () => {
    const allowed = new Set(ALLOWED.map(key));
    expect(found.map(key).filter((site) => !allowed.has(site))).toEqual([]);
  });

  it('lists nothing that no longer exists, so the list stays a true record', () => {
    const present = new Set(found.map(key));
    expect(ALLOWED.map(key).filter((site) => !present.has(site))).toEqual([]);
  });

  it('gives every entry a reason', () => {
    for (const entry of ALLOWED) expect(entry.why.length, key(entry)).toBeGreaterThan(20);
  });

  it('recognizes each form a skip takes', () => {
    for (const line of [
      "it.skip('x', () => {});",
      "describe.only('x', () => {});",
      'const maybe = windows ? it.skip : it;',
      "it.skipIf(windows)('x', () => {});",
      "test.runIf(linux)('x', () => {});",
      "it.todo('x');",
      "describe.concurrent.skip('x', () => {});",
      'context.skip();',
    ]) {
      expect(SKIP.test(line), line).toBe(true);
    }
    expect(SKIP.test('return scenario.skip?.platforms;')).toBe(false);
  });
});
