import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTempProject } from '@lorepack/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from './helpers.js';

/**
 * `lorepack connect` and `lorepack disconnect` at the command level.
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

/**
 * Claude Code keeps its local scope in `$CLAUDE_CONFIG_DIR/.claude.json`, so every test here
 * points that at a temporary directory. Without it, `disconnect` would read the developer's
 * own `~/.claude.json`.
 */
let claudeConfig: string;
let previousClaudeConfig: string | undefined;

beforeEach(() => {
  previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  claudeConfig = mkdtempSync(join(tmpdir(), 'lore-claude-config-'));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
});

afterEach(() => {
  if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
  rmSync(claudeConfig, { recursive: true, force: true });
});

const FILES = { 'lore.yaml': 'version: 1\nname: connect\nsources:\n  - .\n', 'a.md': '# A\n' };

describe('which clients exist', () => {
  it('names every verified client in the snippet advice, and nothing else', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'connect', '--snippet']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Verified clients: claude-code, codex, vscode.');
      // Naming a client before its adapter exists is the overclaim architecture 14.7 forbids:
      // a snippet that looks verified and is not.
      expect(result.stdout).not.toContain('cursor');
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
      // Claude Code's local scope is its own state file, keyed by project (#575).
      expect(result.stdout).toContain(join(claudeConfig, '.claude.json'));
      expect(result.stdout).toContain(join('.codex', 'config.toml'));
      expect(result.stdout).toContain(join('.vscode', 'mcp.json'));
    });
  });

  it('takes back a Claude Code entry an earlier version wrote where the client never looked', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      const legacy = join(temp.root, '.claude', 'settings.local.json');
      mkdirSync(join(temp.root, '.claude'));
      writeFileSync(
        legacy,
        JSON.stringify({
          permissions: { allow: [] },
          mcpServers: {
            lorepack: {
              command: 'lorepack',
              'x-lorepack': { projectRoot: temp.root, createdAt: '2026-08-01T00:00:00.000Z' },
            },
          },
        }),
      );

      const result = await run(['--cwd', temp.root, 'disconnect', 'claude-code']);

      expect(result.code).toBe(0);
      expect(JSON.parse(readFileSync(legacy, 'utf8'))).toEqual({ permissions: { allow: [] } });
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

/**
 * A repository can ship a client configuration as a link to the user's own secrets (#574).
 *
 * `disconnect` is the command that reaches every adapter whether or not its client is
 * installed, so it is the one that proves the refusal on a machine with no clients at all.
 * Skipped on Windows, where creating a symbolic link needs administrator rights or Developer
 * Mode; the adapter suites cover the same refusal on macOS and Linux.
 */
describe('a project configuration that is a link', () => {
  it.skipIf(process.platform === 'win32')(
    'is refused, and the file it points at is neither read into the project nor changed',
    async () => {
      const outside = mkdtempSync(join(tmpdir(), 'lore-secrets-'));
      try {
        const secret = join(outside, 'claude.json');
        const text = '{\n  "primaryApiKey": "sk-ant-SECRET",\n  "mcpServers": {}\n}\n';
        writeFileSync(secret, text, { mode: 0o600 });

        await withTempProject({ files: FILES }, async (temp) => {
          const link = join(temp.root, '.vscode', 'mcp.json');
          mkdirSync(join(temp.root, '.vscode'));
          symlinkSync(secret, link);

          const result = await run(['--cwd', temp.root, 'disconnect', 'vscode']);

          expect(result.code).toBe(1);
          expect(result.stderr).toContain('LORE_E_PATH_ESCAPE');
          expect(result.stderr).toContain('symbolic link');
          expect(lstatSync(link).isSymbolicLink()).toBe(true);
          expect(readdirSync(join(temp.root, '.vscode'))).toEqual(['mcp.json']);
        });

        expect(readFileSync(secret, 'utf8')).toBe(text);
        expect(readdirSync(outside)).toEqual(['claude.json']);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});
