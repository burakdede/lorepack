import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveExecutable, runExecutable } from '../src/executable.js';

/**
 * Finding and running a client's command without ever looking in the working directory (#577).
 *
 * The fixtures are real files and the processes are real. Each test writes the form a client
 * actually takes on the platform it runs on: a batch file on Windows, which is how npm
 * installs `codex` and how VS Code ships `code`, and an executable script elsewhere. The
 * Windows runner is where both halves of the issue live, and these run there unchanged.
 */

const WINDOWS = process.platform === 'win32';

let scratch: string;
let onPath: string;
let project: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lore-executable-'));
  onPath = join(scratch, 'bin');
  project = join(scratch, 'project');
  mkdirSync(onPath);
  mkdirSync(project);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Writes a runnable stand-in that prints `output`, and returns its path. */
function command(directory: string, name: string, output: string): string {
  if (WINDOWS) {
    const path = join(directory, `${name}.cmd`);
    writeFileSync(path, `@echo off\r\necho ${output} %*\r\n`);
    return path;
  }
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\necho ${output} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

const env = (path: string): NodeJS.ProcessEnv => ({ ...process.env, PATH: path, Path: path });

describe('resolving a name', () => {
  it('finds it through an absolute PATH entry', () => {
    const expected = command(onPath, 'fake-client', 'real');

    expect(resolveExecutable('fake-client', { env: env(onPath) })).toBe(expected);
  });

  it('never finds one in the working directory, or through a relative PATH entry', () => {
    command(project, 'fake-client', 'planted');
    const previous = process.cwd();
    process.chdir(project);
    try {
      for (const path of ['', '.', 'bin', `.${delimiter}${delimiter}`]) {
        expect(resolveExecutable('fake-client', { env: env(path) }), path).toBeUndefined();
      }
    } finally {
      process.chdir(previous);
    }
  });

  it('prefers the PATH copy over a planted one, whatever the working directory', () => {
    const expected = command(onPath, 'fake-client', 'real');
    command(project, 'fake-client', 'planted');
    const previous = process.cwd();
    process.chdir(project);
    try {
      expect(resolveExecutable('fake-client', { env: env(`.${delimiter}${onPath}`) })).toBe(
        expected,
      );
    } finally {
      process.chdir(previous);
    }
  });

  it('skips a file of the right name that cannot be run', () => {
    // On Windows the extension decides; elsewhere the execute bit does.
    writeFileSync(join(onPath, WINDOWS ? 'fake-client.txt' : 'fake-client'), 'not runnable');

    expect(resolveExecutable('fake-client', { env: env(onPath) })).toBeUndefined();
  });
});

describe('running a client', () => {
  it('runs the PATH copy, including a Windows batch file, with its arguments', async () => {
    command(onPath, 'fake-client', 'real');

    const { stdout } = await runExecutable('fake-client', ['--version'], { env: env(onPath) });

    expect(stdout.trim()).toBe('real --version');
  });

  it('reports a name only the working directory has as not found, and runs nothing', async () => {
    command(project, 'fake-client', 'planted');

    await expect(
      runExecutable('fake-client', ['--version'], { cwd: project, env: env(`.${delimiter}`) }),
    ).rejects.toThrow('was not found on the PATH');
  });
});
