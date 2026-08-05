import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { run } from './helpers.js';

/**
 * `lore connect` and `lore disconnect` at the command level.
 *
 * The adapters have their own suites, and the shared contract suite covers what must be true
 * of every one of them. What is only true here is the *registration*: which clients exist,
 * what the snippet says about them, and that `disconnect` names the file it would touch. Each
 * of those is a hardcoded list somewhere, and a list that drifts is how a client ends up half
 * supported.
 *
 * Nothing here depends on a client being installed, deliberately. A test whose result changes
 * because the developer happens to have Codex on their path is a test that fails for the wrong
 * reason on somebody else's machine.
 */

const FILES = { 'lore.yaml': 'version: 1\nname: connect\nsources:\n  - .\n', 'a.md': '# A\n' };

describe('which clients exist', () => {
  it('names every verified client in the snippet advice, and nothing else', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'connect', '--snippet']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Verified clients: claude-code, codex.');
      // VS Code is #81. Naming it before the adapter exists is the overclaim architecture
      // 14.7 forbids: a snippet that looks verified and is not.
      expect(result.stdout).not.toContain('vscode');
    });
  });

  it('offers a snippet for a client nobody has verified, rather than failing', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'connect', 'some-other-editor']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('no verified adapter for some-other-editor');
      expect(result.stdout).toContain('Nothing was changed.');
    });
  });

  it('changes nothing when asked only for a snippet', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      await run(['--cwd', temp.root, 'connect', '--snippet']);

      expect(existsSync(join(temp.root, '.codex'))).toBe(false);
      expect(existsSync(join(temp.root, '.claude'))).toBe(false);
      expect(existsSync(join(temp.root, '.mcp.json'))).toBe(false);
    });
  });
});

describe('disconnect', () => {
  it('names the file it would take an entry out of, for each client', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'disconnect']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(join('.claude', 'settings.local.json'));
      expect(result.stdout).toContain(join('.codex', 'config.toml'));
    });
  });

  it('leaves a Codex entry somebody else wrote exactly where it is', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      const path = join(temp.root, '.codex', 'config.toml');
      const theirs = '# mine\n\n[mcp_servers.lorepack]\ncommand = "their-own-thing"\n';
      mkdirSync(join(temp.root, '.codex'), { recursive: true });
      writeFileSync(path, theirs, 'utf8');

      const result = await run(['--cwd', temp.root, 'disconnect', 'codex']);

      expect(result.code).toBe(0);
      // No ownership comment, so it is not ours. The wording is deliberately unconditional
      // because `remove` leaves what it did not create, and the file proves which happened.
      expect(readFileSync(path, 'utf8')).toBe(theirs);
    });
  });
});
