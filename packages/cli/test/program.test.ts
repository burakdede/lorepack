import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { EXIT_CODES, LoreError } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it, vi } from 'vitest';
import { validateCommandMetadata } from '../src/framework/metadata.js';
import { runCli } from '../src/framework/program.js';
import { fixtureCommands, run } from './helpers.js';

const commands = fixtureCommands;

it('refreshes a quiet async stage without fabricating completed work', async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  let progress = '';
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  stderr.on('data', (chunk: Buffer) => {
    progress += chunk.toString();
  });
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = runCli(['node', 'lorepack', '--json', 'quiet'], {
    commands: [
      {
        name: 'quiet',
        description: 'Wait without producer events',
        handler: async (_args, _flags, context) => {
          context.progress.start('parsing', 'Parsing', 2);
          await waiting;
          context.progress.finish('parsing', 2);
          return { json: { ok: true } };
        },
      },
    ],
    streams: { stdout, stderr, isTty: false },
    exitProcess: false,
  });
  try {
    await delay(1_200);
    const lines = progress.trim().split('\n');
    expect(lines.filter((line) => /^Parsing +0\/2 +/.test(line))).toHaveLength(2);
    expect(lines.at(-1)).toMatch(/^Parsing +0\/2 +1\.\d+s$/);
    expect(output).toBe('');
  } finally {
    release();
    expect(await pending).toBe(0);
  }
  expect(JSON.parse(output)).toEqual({ ok: true });
});

it('closes an unfinished TTY progress row before writing the command result', async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const code = await runCli(['node', 'lorepack', 'unfinished'], {
    commands: [
      {
        name: 'unfinished',
        description: 'Return with an unfinished stage',
        handler: (_args, _flags, context) => {
          context.progress.start('parsing', 'Parsing', 2);
          return { human: 'Summary' };
        },
      },
    ],
    streams: { stdout, stderr, isTty: true },
    env: { NO_COLOR: '1' },
    exitProcess: false,
  });
  expect(code).toBe(0);
  const text = stdout.read()?.toString();
  expect(text).toContain('\nSummary\n');
  expect(text).not.toContain('done');
});

it.each(['success', 'error', 'cancel'] as const)(
  'disposes quiet refresh on %s and keeps repeated invocations isolated',
  async (outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const timers = vi.getTimerCount();
      for (let invocation = 0; invocation < 2; invocation += 1) {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let output = '';
        let progress = '';
        stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        stderr.on('data', (chunk: Buffer) => {
          progress += chunk.toString();
        });
        const controller = new AbortController();
        let settle: ((error?: LoreError) => void) | undefined;
        let update: (() => void) | undefined;
        let late: (() => void) | undefined;
        const pending = runCli(['node', 'lorepack', '--json', 'quiet'], {
          commands: [
            {
              name: 'quiet',
              description: 'Controlled quiet work',
              handler: async (_args, _flags, context) => {
                context.progress.start('parsing', 'Parsing', 2);
                update = () => context.progress.progress('parsing', 1);
                late = () => context.progress.start('indexing', 'Late');
                const abort = () =>
                  settle?.(new LoreError('LORE_E_CANCELLED', 'Stopped controlled work.'));
                context.signal?.addEventListener('abort', abort, { once: true });
                try {
                  await new Promise<void>((resolve, reject) => {
                    settle = (error) => (error === undefined ? resolve() : reject(error));
                  });
                  context.progress.finish('parsing', 2);
                  return { json: { ok: true } };
                } finally {
                  context.signal?.removeEventListener('abort', abort);
                }
              },
            },
          ],
          streams: { stdout, stderr, isTty: false },
          exitProcess: false,
          signal: controller.signal,
        });
        try {
          await vi.advanceTimersByTimeAsync(900);
          expect(update).toBeTypeOf('function');
          update?.();
          await vi.advanceTimersByTimeAsync(1100);
          expect(progress).toMatch(/Parsing +1\/2 +1\.0s/);
          expect(progress).toMatch(/Parsing +1\/2 +2\.0s/);
          expect(output).toBe('');
          if (outcome === 'cancel') controller.abort();
          else
            settle?.(
              outcome === 'error'
                ? new LoreError('LORE_E_PARSE_FAILED', 'Controlled failure.')
                : undefined,
            );
          const code = await pending;
          if (outcome === 'success') {
            expect(code).toBe(0);
            expect(JSON.parse(output)).toEqual({ ok: true });
          } else {
            expect(code).not.toBe(0);
            expect(JSON.parse(output)).toMatchObject({
              error: { code: outcome === 'cancel' ? 'LORE_E_CANCELLED' : 'LORE_E_PARSE_FAILED' },
            });
          }
          expect(vi.getTimerCount()).toBe(timers);
          const stopped = { output, progress };
          late?.();
          await vi.advanceTimersByTimeAsync(2000);
          expect({ output, progress }).toEqual(stopped);
        } finally {
          settle?.();
          await pending;
        }
      }
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

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

describe('command metadata', () => {
  it('rejects duplicate command names and flags before registration', () => {
    expect(() =>
      validateCommandMetadata([
        { name: 'same', description: 'one' },
        { name: 'same', description: 'two' },
      ]),
    ).toThrow('Duplicate command name: same.');

    expect(() =>
      validateCommandMetadata([
        {
          name: 'build',
          description: 'build',
          flags: [{ flags: '--frozen, --frozen', description: 'duplicate' }],
        },
      ]),
    ).toThrow('Duplicate flag --frozen on build.');
  });

  it('accepts completion metadata without requiring a provider', () => {
    expect(() =>
      validateCommandMetadata([
        {
          name: 'inspect',
          description: 'inspect',
          arguments: [{ name: 'subject', description: 'subject', values: ['build', 'sources'] }],
          examples: [{ command: 'lore inspect build', description: 'show the active build' }],
        },
      ]),
    ).not.toThrow();
  });
});

describe('shell completion', () => {
  it('prints a usable zsh completion script', async () => {
    const result = await run(['completion', 'zsh']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('compdef _lorepack lorepack');
    expect(result.stdout).toContain('build');
    expect(result.stdout).toContain('connect');
  });
});

describe('unknown input', () => {
  it('rejects an unknown command with a typed error, not a stack trace', async () => {
    const result = await run(['nonsense'], { commands });
    expect(result.code).toBe(EXIT_CODES.USER);
    expect(result.stderr).toContain('LORE_E_INVALID_ARGUMENT');
    expect(result.stderr).toContain('lorepack --help');
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
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'entry.ts'), 'utf8');
    const guardImport = source.indexOf('@lorepack/core/engine');
    const guardCall = source.indexOf('assertSupportedNode()');
    const dynamicImport = source.indexOf('await import(');

    expect(guardImport).toBeGreaterThanOrEqual(0);
    expect(guardCall).toBeGreaterThan(guardImport);
    expect(dynamicImport).toBeGreaterThan(guardCall);

    // The SQLite floor is checked before the program is loaded, so no command can reach an
    // FTS5 MATCH on a SQLite with the 3.53.2 FTS5 fixes missing.
    const sqliteImport = source.indexOf("await import('node:sqlite')");
    const sqliteCall = source.indexOf('assertSupportedSqlite(version)');
    const programImport = source.indexOf("await import('./framework/program.js')");
    expect(sqliteImport).toBeGreaterThan(guardCall);
    expect(sqliteCall).toBeGreaterThan(sqliteImport);
    expect(programImport).toBeGreaterThan(sqliteCall);

    // Everything except the guard must be loaded dynamically, after the check.
    const staticImports = [...source.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]);
    expect(staticImports).toEqual(['@lorepack/core/engine']);
  });
});

describe('corpus text on its way to a terminal (#579)', () => {
  const ESC = '\u001b';
  const hostile = `docs/evil${ESC}]0;PWNED\u0007.md`;
  const reporting = [
    ...commands,
    {
      name: 'report',
      description: 'Reports a file name, through every human channel.',
      handler: (_args, _flags, context) => {
        context.write(`writing ${hostile}\n`);
        context.warn(`warning ${hostile}\n`);
        return { human: `result ${hostile}`, json: { path: hostile, controls: '\u007f\u009b' } };
      },
    },
    {
      name: 'document',
      description: 'Returns a document the user asked for.',
      handler: () => ({ human: `body ${hostile}\u009b`, verbatim: true }),
    },
  ] satisfies typeof commands;

  it('shows control sequences in every human channel rather than sending them', async () => {
    const result = await run(['report'], { commands: reporting });

    expect(`${result.stdout}${result.stderr}`).not.toContain(ESC);
    expect(result.stdout).toContain('result docs/evil\\x1b]0;PWNED\\x07.md');
    expect(result.stdout).toContain('writing docs/evil\\x1b]0;PWNED\\x07.md');
    expect(result.stderr).toContain('warning docs/evil\\x1b]0;PWNED\\x07.md');
  });

  it('keeps JSON source values intact without terminal escaping', async () => {
    const result = await run(['--json', 'report'], { commands: reporting });

    expect(result.stdout).not.toContain(ESC);
    expect(JSON.parse(result.stdout)).toEqual({ path: hostile, controls: '\u007f\u009b' });
  });

  it('writes a requested document byte for byte when it is redirected', async () => {
    const result = await run(['document'], { commands: reporting });

    // Not a terminal, so `lorepack export > file.md` matches `--output file.md`.
    expect(result.stdout).toBe(`body ${hostile}\u009b\n`);
  });

  it('escapes requested document controls on a terminal', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await runCli(['node', 'lorepack', 'document'], {
      commands: reporting,
      streams: { stdout, stderr, isTty: true },
      exitProcess: false,
    });

    expect(code).toBe(0);
    expect(stdout.read()?.toString()).toBe('body docs/evil\\x1b]0;PWNED\\x07.md\\x9b\n');
    expect(stderr.read()).toBeNull();
  });
});
