import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoreError } from '@lorepack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backup, resolveConfigFile, writeFileAtomically } from '../src/config-file.js';

/**
 * The primitive every connector writes through (#574). The connector suites prove each client
 * uses it; these pin the edge cases that are easier to state once, here.
 *
 * Mode assertions are POSIX only: on Windows `chmod` toggles the read-only flag and nothing
 * else. Symlink cases are POSIX only because creating a link on Windows needs administrator
 * rights or Developer Mode, which CI runners do not have.
 */
const posixOnly = it.skipIf(process.platform === 'win32');

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lore-config-file-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe('writing atomically', () => {
  posixOnly('keeps a mode the umask would otherwise strip', () => {
    const path = join(directory, 'shared.json');
    writeFileSync(path, '{}\n');
    chmodSync(path, 0o664);

    writeFileAtomically(path, '{"a":1}\n');

    expect(modeOf(path)).toBe(0o664);
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
  });

  posixOnly('creates a new file with the mode asked for', () => {
    const path = join(directory, 'nested', 'private.json');
    writeFileAtomically(path, '{}\n', { newFileMode: 0o600 });
    expect(modeOf(path)).toBe(0o600);
  });

  it('leaves no temporary file behind when the rename fails', () => {
    // A directory where the file should be makes the final rename fail on every platform.
    const path = join(directory, 'occupied');
    mkdirSync(join(path, 'child'), { recursive: true });

    expect(() => writeFileAtomically(path, '{}\n')).toThrow();
    expect(readdirSync(directory)).toEqual(['occupied']);
  });
});

describe('backing up', () => {
  posixOnly('keeps the original mode on the copy', () => {
    const path = join(directory, 'token.toml');
    writeFileSync(path, 'x = 1\n', { mode: 0o600 });
    chmodSync(path, 0o600);

    const copy = backup(path) as string;
    expect(modeOf(copy)).toBe(0o600);
  });

  posixOnly('refuses to write through a link planted at the backup name', () => {
    const path = join(directory, 'config.toml');
    writeFileSync(path, 'x = 1\n');
    const victim = join(directory, 'victim');
    writeFileSync(victim, 'untouched');
    const now = () => new Date('2026-10-10T00:00:00.000Z');
    symlinkSync(victim, `${path}.lorepack-2026-10-10T00-00-00-000Z.bak`);

    expect(() => backup(path, now)).toThrow(/EEXIST/);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
  });
});

describe('resolving which file to edit', () => {
  posixOnly('follows a user link to its target', () => {
    const target = join(directory, 'dotfiles', 'claude.json');
    mkdirSync(join(directory, 'dotfiles'));
    writeFileSync(target, '{}\n');
    const link = join(directory, '.claude.json');
    symlinkSync(target, link);

    expect(resolveConfigFile(link, { owner: 'user' })).toBe(realpathSync(target));
  });

  posixOnly('refuses a user link whose target is missing, with a typed error', () => {
    const link = join(directory, '.claude.json');
    symlinkSync(join(directory, 'gone.json'), link);

    const error = (() => {
      try {
        resolveConfigFile(link, { owner: 'user' });
      } catch (caught) {
        return caught;
      }
    })();
    expect(LoreError.is(error) && error.code).toBe('LORE_E_SOURCE_UNREADABLE');
  });

  it('returns a project path that does not exist yet unchanged', () => {
    const path = join(directory, '.vscode', 'mcp.json');
    expect(resolveConfigFile(path, { owner: 'project', projectRoot: directory })).toBe(path);
  });

  posixOnly('names the offending link relative to the project', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'lore-elsewhere-'));
    try {
      symlinkSync(elsewhere, join(directory, '.codex'), 'dir');
      const path = join(directory, '.codex', 'config.toml');

      expect(() => resolveConfigFile(path, { owner: 'project', projectRoot: directory })).toThrow(
        /^\.codex is a symbolic link/,
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
