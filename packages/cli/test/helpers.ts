import { LoreError } from '@lorepack/core';
import type { CommandDefinition, RunOptions } from '../src/framework/program.js';
import { runCli } from '../src/framework/program.js';

export interface CapturedRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

class Capture {
  text = '';
  write(chunk: string | Uint8Array): boolean {
    this.text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}

/** Runs the CLI in-process with captured streams, so tests assert output and exit code. */
export async function run(
  argv: readonly string[],
  options: Omit<RunOptions, 'streams' | 'exitProcess'> = {},
): Promise<CapturedRun> {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runCli(['node', 'lore', ...argv], {
    ...options,
    exitProcess: false,
    streams: {
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      isTty: false,
    },
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

export const fixtureCommands: CommandDefinition[] = [
  {
    name: 'succeed',
    description: 'A command that succeeds.',
    handler: () => ({ human: 'all good', json: { ok: true } }),
  },
  {
    name: 'progress',
    description: 'A command that reports progress and returns a result.',
    handler: (_args, _flags, context) => {
      context.progress.start('parsing', 'Parsing', 2);
      context.progress.finish('parsing', 2);
      return { human: 'done', json: { parsed: 2 } };
    },
  },
  {
    name: 'fail-user',
    description: 'Fails with a user error.',
    handler: () => {
      throw new LoreError('LORE_E_CONFIG_INVALID', 'lore.yaml is invalid at `name`.', {
        remediation: 'Fix the name field.',
        path: 'lore.yaml',
      });
    },
  },
  {
    name: 'fail-build',
    description: 'Fails with a build error.',
    handler: () => {
      throw new LoreError('LORE_E_BUILD_VALIDATION', 'candidate rejected');
    },
  },
  {
    name: 'fail-environment',
    description: 'Fails with an environment error.',
    handler: () => {
      throw new LoreError('LORE_E_FTS5_UNAVAILABLE', 'no fts5');
    },
  },
  {
    name: 'fail-lock',
    description: 'Fails with a concurrency error.',
    handler: () => {
      throw new LoreError('LORE_E_LOCK_HELD', 'held by pid 1');
    },
  },
  {
    name: 'fail-remote',
    description: 'Fails with a remote error.',
    handler: () => {
      throw new LoreError('LORE_E_REMOTE_DEPLOY', 'projection failed');
    },
  },
  {
    name: 'fail-unexpected',
    description: 'Throws something that is not a LoreError.',
    handler: () => {
      throw new TypeError('undefined is not a function');
    },
  },
  {
    name: 'show-cwd',
    description: 'Reports the resolved working directory.',
    handler: (_args, _flags, context) => ({
      human: context.options.cwd,
      json: { cwd: context.options.cwd },
    }),
  },
  {
    name: 'show-flags',
    description: 'Reports resolved global options.',
    handler: (_args, _flags, context) => ({ json: context.options, human: 'flags' }),
  },
  {
    name: 'echo',
    description: 'Echoes its arguments.',
    arguments: [
      { name: 'first', description: 'first argument' },
      { name: 'second', description: 'optional second', required: false },
    ],
    handler: (args) => ({ human: args.join(','), json: { args } }),
  },
];
