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
import type { ClientConnector, ConnectionCheck } from '@lorepack/connect-clients';
import { withTempProject } from '@lorepack/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectCommand } from '../src/commands/connect.js';
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

/**
 * A connector that records what it was asked to do, and answers verification as told.
 *
 * The real adapters are covered by their own suites. What these tests pin is the order the
 * command imposes on them: every plan before any write, and no write without a yes.
 */
function recording(check: ConnectionCheck): { connector: ClientConnector; applied: string[] } {
  const applied: string[] = [];
  const connector: ClientConnector = {
    id: 'fake',
    title: 'Fake Client',
    detect: async () => ({ installed: true, supported: true, version: '9.9.9' }),
    status: async () => ({
      installed: true,
      supported: true,
      configured: false,
      ownedByLorepack: false,
    }),
    plan: async (input) => ({
      clientId: 'fake',
      scope: input.scope,
      projectRoot: input.projectRoot,
      configPath: join(input.projectRoot, 'fake.json'),
      changes: ['Add an MCP server named lorepack to fake.json'],
      entry: {},
      serverName: input.serverName,
    }),
    apply: async (plan) => {
      applied.push(plan.configPath ?? '');
      return {
        clientId: 'fake',
        scope: plan.scope,
        projectRoot: plan.projectRoot,
        serverName: plan.serverName,
        configPath: plan.configPath,
        connectedAt: new Date(0).toISOString(),
      };
    },
    verify: async () => check,
    remove: async () => undefined,
  };
  return { connector, applied };
}

const WORKS: ConnectionCheck = { ok: true, step: 'none', detail: 'Answered with 7 tools.' };

describe('asking before writing (#576)', () => {
  it('refuses without a terminal or --yes, and writes nothing', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      const fake = recording(WORKS);
      const commands = [connectCommand({ connectors: () => [fake.connector] })];

      const result = await run(['--cwd', temp.root, 'connect'], { commands });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('LORE_E_INVALID_ARGUMENT');
      expect(result.stderr).toContain('--yes');
      // The plan is still printed, so a refused script shows what it would have done.
      expect(result.stdout).toContain('Add an MCP server named lorepack to fake.json');
      expect(fake.applied).toEqual([]);
    });
  });

  it('shows the whole plan, then applies it once the answer is yes', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      const fake = recording(WORKS);
      const asked: string[] = [];
      const commands = [
        connectCommand({
          connectors: () => [fake.connector],
          confirm: async (plan) => {
            // Nothing may have been written yet when the question is asked.
            expect(fake.applied).toEqual([]);
            asked.push(plan);
            return true;
          },
        }),
      ];

      const result = await run(['--cwd', temp.root, 'connect'], { commands });

      expect(result.code).toBe(0);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('Add an MCP server named lorepack to fake.json');
      expect(fake.applied).toEqual([join(temp.root, 'fake.json')]);
      expect(result.stdout).toContain('Verified: Answered with 7 tools.');
      // Already read at the prompt, so not printed a second time.
      expect(result.stdout).not.toContain('Add an MCP server');
    });
  });

  it('writes nothing when the answer is no', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      const fake = recording(WORKS);
      const commands = [
        connectCommand({ connectors: () => [fake.connector], confirm: async () => false }),
      ];

      const result = await run(['--cwd', temp.root, 'connect'], { commands });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Cancelled. Nothing was changed.');
      expect(fake.applied).toEqual([]);
    });
  });

  it('does not ask with --yes, or with --dry-run', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      const fake = recording(WORKS);
      const never = async (): Promise<boolean> => {
        throw new Error('asked');
      };
      const commands = [connectCommand({ connectors: () => [fake.connector], confirm: never })];

      const dry = await run(['--cwd', temp.root, 'connect', '--dry-run'], { commands });
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain('(dry run, nothing was changed)');
      expect(fake.applied).toEqual([]);

      const yes = await run(['--cwd', temp.root, 'connect', '--yes'], { commands });
      expect(yes.code).toBe(0);
      expect(yes.stdout).toContain('Add an MCP server named lorepack to fake.json');
      expect(fake.applied).toHaveLength(1);
    });
  });
});

describe('the exit code after verification (#578)', () => {
  it('is non-zero when the written server does not start', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      const fake = recording({ ok: false, step: 'spawn', detail: 'spawn timed out' });
      const commands = [connectCommand({ connectors: () => [fake.connector] })];

      const result = await run(['--cwd', temp.root, '--json', 'connect', '--yes'], { commands });

      expect(result.code).toBe(3);
      const parsed = JSON.parse(result.stdout) as { checks: ConnectionCheck[] };
      expect(parsed.checks).toEqual([{ ok: false, step: 'spawn', detail: 'spawn timed out' }]);
    });
  });

  it('is zero when only a trust step in the client remains', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      const fake = recording({
        ok: false,
        step: 'trust',
        detail: 'Approve it in the client.',
        pendingTrust: true,
      });
      const commands = [connectCommand({ connectors: () => [fake.connector] })];

      const result = await run(['--cwd', temp.root, 'connect', '--yes'], { commands });

      expect(result.code).toBe(0);
    });
  });
});
