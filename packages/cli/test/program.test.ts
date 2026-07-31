import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_CODES } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { fixtureCommands, run } from './helpers.js';

const commands = fixtureCommands;

describe('help and version', () => {
  it('prints help and exits 0 with no arguments', async () => {
    const result = await run([], { commands });
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Usage: lore');
  });

  it('lists registered commands in help', async () => {
    const result = await run(['--help'], { commands });
    expect(result.code).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('succeed');
    expect(output).toContain('Build, version, and deploy the context your AI depends on.');
  });

  it('prints the version and exits 0', async () => {
    const result = await run(['--version'], { commands, version: '0.1.0' });
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('0.1.0');
  });
});

describe('unknown input', () => {
  it('rejects an unknown command with a typed error, not a stack trace', async () => {
    const result = await run(['nonsense'], { commands });
    expect(result.code).toBe(EXIT_CODES.USER);
    expect(result.stderr).toContain('LORE_E_INVALID_ARGUMENT');
    expect(result.stderr).toContain('lore --help');
    expect(result.stderr).not.toContain('at Object.');
  });

  it('suggests the closest command for a near miss', async () => {
    const result = await run(['succed'], { commands });
    expect(result.code).toBe(EXIT_CODES.USER);
    expect(result.stderr.toLowerCase()).toContain('succeed');
  });

  it('rejects a missing required argument', async () => {
    const result = await run(['echo'], { commands });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('first');
  });
});

describe('exit-code contract', () => {
  it.each([
    ['fail-user', EXIT_CODES.USER],
    ['fail-build', EXIT_CODES.BUILD],
    ['fail-environment', EXIT_CODES.ENVIRONMENT],
    ['fail-lock', EXIT_CODES.CONCURRENCY],
    ['fail-remote', EXIT_CODES.REMOTE],
  ])('%s exits %i', async (command, expected) => {
    const result = await run([command], { commands });
    expect(result.code).toBe(expected);
  });

  it('wraps an unexpected throw as an internal error rather than crashing', async () => {
    const result = await run(['fail-unexpected'], { commands });
    expect(result.code).toBe(EXIT_CODES.USER);
    expect(result.stderr).toContain('LORE_E_INTERNAL');
    expect(result.stderr).toContain('undefined is not a function');
  });

  it('renders the remediation, which is what makes an error actionable', async () => {
    const result = await run(['fail-user'], { commands });
    expect(result.stderr).toContain('next: Fix the name field.');
    expect(result.stderr).toContain('path: lore.yaml');
  });

  it('exits 0 on success', async () => {
    const result = await run(['succeed'], { commands });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('all good');
  });
});

describe('--json', () => {
  it('puts only the structured result on stdout', async () => {
    const result = await run(['--json', 'succeed'], { commands });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  });

  it('moves progress and human output to stderr, so stdout stays pipeable', async () => {
    const result = await run(['--json', 'progress'], { commands });
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toEqual({ parsed: 2 });
    expect(result.stdout).not.toContain('Parsing');
    expect(result.stderr).toContain('Parsing');
  });

  it('renders an error as JSON on stdout when json mode is active', async () => {
    const result = await run(['--json', 'fail-user'], { commands });
    expect(result.code).toBe(EXIT_CODES.USER);
    const parsed = JSON.parse(result.stdout) as { error: { code: string; remediation: string } };
    expect(parsed.error.code).toBe('LORE_E_CONFIG_INVALID');
    expect(parsed.error.remediation).toContain('Fix the name field');
  });

  it('writes human output to stdout when json mode is off', async () => {
    const result = await run(['progress'], { commands });
    expect(result.stdout).toContain('Parsing');
    expect(result.stdout).toContain('done');
  });
});

describe('global options', () => {
  it('resolves --cwd to an absolute path without changing process.cwd', async () => {
    await withTempProject({ files: { 'a.md': '#' } }, async (project) => {
      const before = process.cwd();
      const result = await run(['--json', '--cwd', project.root, 'show-cwd'], { commands });
      expect(JSON.parse(result.stdout)).toEqual({ cwd: project.root });
      expect(process.cwd()).toBe(before);
    });
  });

  it('handles a --cwd containing spaces', async () => {
    await withTempProject({ files: { 'dir with spaces/a.md': '#' } }, async (project) => {
      const target = join(project.root, 'dir with spaces');
      const result = await run(['--json', '--cwd', target, 'show-cwd'], { commands });
      expect(JSON.parse(result.stdout)).toEqual({ cwd: target });
    });
  });

  it('defaults --cwd to the process directory', async () => {
    const result = await run(['--json', 'show-cwd'], { commands });
    expect(JSON.parse(result.stdout)).toEqual({ cwd: process.cwd() });
  });

  it('honours --no-color', async () => {
    const result = await run(['--json', '--no-color', 'show-flags'], { commands });
    expect((JSON.parse(result.stdout) as { color: boolean }).color).toBe(false);
  });

  it('honours NO_COLOR from the environment', async () => {
    const result = await run(['--json', 'show-flags'], { commands, env: { NO_COLOR: '1' } });
    expect((JSON.parse(result.stdout) as { color: boolean }).color).toBe(false);
  });

  it('honours FORCE_COLOR=0 even when a TTY would enable colour', async () => {
    const result = await run(['--json', 'show-flags'], { commands, env: { FORCE_COLOR: '0' } });
    expect((JSON.parse(result.stdout) as { color: boolean }).color).toBe(false);
  });

  it('passes --verbose through to the context', async () => {
    const result = await run(['--json', '--verbose', 'show-flags'], { commands });
    expect((JSON.parse(result.stdout) as { verbose: boolean }).verbose).toBe(true);
  });
});

describe('arguments', () => {
  it('passes positional arguments to the handler in order', async () => {
    const result = await run(['--json', 'echo', 'one', 'two'], { commands });
    expect(JSON.parse(result.stdout)).toEqual({ args: ['one', 'two'] });
  });

  it('accepts an omitted optional argument', async () => {
    const result = await run(['--json', 'echo', 'only'], { commands });
    expect(JSON.parse(result.stdout)).toEqual({ args: ['only'] });
  });
});

describe('entry point', () => {
  it('checks the Node version before importing anything heavy', () => {
    // The guard is only useful if it runs first. An eager import of the compiler or the
    // storage layer would fail on an unsupported runtime before the guard could speak.
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'bin', 'lore.ts'), 'utf8');
    const guardImport = source.indexOf('@lorepack/core/engine');
    const guardCall = source.indexOf('assertSupportedNode()');
    const dynamicImport = source.indexOf('await import(');

    expect(guardImport).toBeGreaterThanOrEqual(0);
    expect(guardCall).toBeGreaterThan(guardImport);
    expect(dynamicImport).toBeGreaterThan(guardCall);

    // Everything except the guard must be loaded dynamically, after the check.
    const staticImports = [...source.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]);
    expect(staticImports).toEqual(['@lorepack/core/engine']);
  });
});
