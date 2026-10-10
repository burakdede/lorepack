import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `lorepack connect` driven as a person meets it: the built binary, a real project, and a
 * home directory that is not the developer's.
 *
 * Every client and the `lorepack` the configuration names are stand-ins on `PATH`, written
 * fresh for each test, so the result never depends on what this machine has installed and no
 * real client configuration is ever read or written. `HOME`, `USERPROFILE`, `APPDATA`,
 * `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` all point into the temporary home.
 */

const ENTRY = join(import.meta.dirname, '..', 'dist', 'public-entry.js');
const WINDOWS = process.platform === 'win32';

let scratch: string;
let project: string;
let home: string;
let bin: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lore-connect-e2e-'));
  project = join(scratch, 'project');
  home = join(scratch, 'home');
  bin = join(scratch, 'bin');
  for (const directory of [project, home, bin]) mkdirSync(directory);
  writeFileSync(join(project, 'lore.yaml'), 'version: 1\nname: connected\nsources:\n  - .\n');
  writeFileSync(join(project, 'a.md'), '# A\n\nRollback restores the previous build.\n');

  fake('claude', 'echo 2.1.296');
  fake('codex', 'echo codex-cli 0.146.1');
  fake('code', 'echo 1.132.0');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A stand-in executable on the test `PATH`: a batch file on Windows, a shell script elsewhere. */
function fake(name: string, body: string): void {
  if (WINDOWS) {
    writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\n${body}\r\n`);
    return;
  }
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** The `lorepack` the written configuration names, which is the real built CLI. */
function realServer(): void {
  fake(
    'lorepack',
    WINDOWS ? `"${process.execPath}" "${ENTRY}" %*` : `exec "${process.execPath}" "${ENTRY}" "$@"`,
  );
}

/**
 * The CLI, with `PATH` holding only the stand-ins unless told otherwise.
 *
 * Nothing from the developer's own `PATH` is reachable, so a globally installed `lorepack` or
 * `claude` can neither satisfy a test nor be touched by one.
 */
function connect(
  args: readonly string[],
  path: string = bin,
): { code: number; stdout: string; stderr: string } {
  // Windows spells it `Path`, and a second spelling beside it is ambiguous to the child.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'),
  );
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: project,
    encoding: 'utf8',
    // Piped, which is exactly what a script or CI job gives the process: no terminal.
    stdio: ['pipe', 'pipe', 'pipe'],
    input: '',
    timeout: 110_000,
    env: {
      ...inherited,
      PATH: path,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData'),
      XDG_CONFIG_HOME: join(home, '.config'),
      CLAUDE_CONFIG_DIR: home,
      CODEX_HOME: join(home, '.codex'),
      NO_COLOR: '1',
    },
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Every file a connect could have written, inside the project and inside the home. */
function written(): string[] {
  return [
    join(home, '.claude.json'),
    join(home, '.codex', 'config.toml'),
    join(project, '.codex', 'config.toml'),
    join(project, '.vscode', 'mcp.json'),
    join(project, '.mcp.json'),
  ].filter((path) => existsSync(path));
}

describe('consent before a client configuration changes (#576)', () => {
  it('writes nothing and exits non-zero without a terminal or --yes', () => {
    realServer();

    const result = connect(['connect']);

    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('--yes');
    // The plan is still shown, so the refusal tells a script's author what it would have done.
    expect(result.stdout).toContain('Claude Code');
    expect(written()).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it('refuses user scope just the same, leaving the home directory untouched', () => {
    realServer();

    const result = connect(['connect', 'claude-code', '--scope', 'user']);

    expect(result.code).toBe(1);
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
  });

  it('applies and verifies every client with --yes', () => {
    realServer();

    const result = connect(['connect', '--yes']);

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(written().sort()).toEqual(
      [
        join(home, '.claude.json'),
        join(project, '.codex', 'config.toml'),
        join(project, '.vscode', 'mcp.json'),
      ].sort(),
    );
    // VS Code has nothing left to ask; the other two still wait on a trust step, which is
    // reported but is not a failure.
    expect(result.stdout).toContain('Verified: Answered with');
    expect(result.stdout).not.toContain('could not be started');
  });

  it('changes nothing with --dry-run, and needs no --yes to say so', () => {
    realServer();

    const result = connect(['connect', '--dry-run']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('(dry run, nothing was changed)');
    expect(written()).toEqual([]);
  });
});

describe('a connection that does not work (#578)', () => {
  it('exits non-zero, so a script can tell', () => {
    // A `lorepack` that starts and exits at once, which is what a broken install looks like.
    fake('lorepack', 'exit 1');

    const result = connect(['connect', 'vscode', '--yes']);

    expect(result.stdout).toContain('Not working yet');
    expect(result.code).toBe(3);
  });
});
