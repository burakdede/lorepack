import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeCodeSnippet,
  claudeConfigDirectory,
  claudeProjectKey,
  createClaudeCodeConnector,
} from '../src/claude-code.js';
import type { ConnectInput } from '../src/port.js';
import {
  type ConnectorFixture,
  runConfigFileSafetyContract,
  runConnectorContract,
} from './contract.js';

/**
 * The Claude Code adapter.
 *
 * Everything that would be a defect in *any* connector lives in the shared contract suite,
 * which runs twice here: once for the default local scope and once for `--shared`. What
 * remains is what is true of this client alone, measured against Claude Code 2.1.296 (#575):
 *
 * - the local scope lives in `.claude.json`, under `projects[<real project path>].mcpServers`,
 *   and **not** in `.claude/settings.local.json`, which the client never reads servers from;
 * - `.claude.json` is in `$CLAUDE_CONFIG_DIR` when that is set, for every scope.
 *
 * The client binary and the server probe are injected, so these never depend on what the
 * developer has installed, and `.claude.json` always lives in a temporary directory.
 */

let project: string;
let configDirectory: string;

const claudeJson = (): string => join(configDirectory, '.claude.json');
const legacyPath = (root: string): string => join(root, '.claude', 'settings.local.json');

const installed = async () => ({ stdout: '2.1.296 (Claude Code)\n', stderr: '' });
const answers = async () => ({ ok: true, step: 'none' as const, detail: 'Answered with 4 tools.' });

function input(overrides: Partial<ConnectInput> = {}): ConnectInput {
  return {
    projectRoot: project,
    serverName: 'lorepack',
    command: { executable: 'lorepack', args: ['mcp', '--project', project, '--ensure-current'] },
    scope: 'project',
    ...overrides,
  };
}

const parsed = (text: string): Record<string, never> => JSON.parse(text) as Record<string, never>;

/** The servers Claude Code would load for `root` from a `.claude.json`. */
const localServers = (text: string, root: string): Record<string, never> =>
  parsed(text).projects?.[claudeProjectKey(root)]?.mcpServers ?? {};

function writeJson(path: string, document: unknown): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return path;
}

/** A `.claude.json` with the client state real ones carry, and one project configured. */
const claudeState = (root: string, servers: Record<string, unknown>) => ({
  numStartups: 12,
  otherSetting: true,
  mcpServers: { 'a-user-server': { type: 'stdio', command: 'their-global' } },
  projects: {
    '/some/other/project': { allowedTools: [], mcpServers: {} },
    [claudeProjectKey(root)]: { allowedTools: ['Bash'], mcpServers: servers },
  },
});

const localFixture: ConnectorFixture = {
  id: 'claude-code',
  title: 'Claude Code (local scope)',
  create: () => createClaudeCodeConnector({ runClient: installed, configDirectory }),
  createMissing: () =>
    createClaudeCodeConnector({
      configDirectory,
      runClient: async () => {
        throw new Error('spawn claude ENOENT');
      },
    }),
  createForUser: (home) =>
    createClaudeCodeConnector({ runClient: installed, configDirectory: home }),
  userConfigPath: (home) => join(home, '.claude.json'),
  defaultConfigPath: () => claudeJson(),
  seedForeign: (root) =>
    writeJson(
      claudeJson(),
      claudeState(root, {
        'their-server': { type: 'stdio', command: 'their-binary', args: ['--serve'] },
      }),
    ),
  unrelatedSetting: (text) => parsed(text).otherSetting === true,
  seedImpostor: (root) =>
    writeJson(
      claudeJson(),
      claudeState(root, { lorepack: { type: 'stdio', command: 'someone-elses' } }),
    ),
  serverNames: (text) => Object.keys(localServers(text, project)),
  entry: (text, name) => localServers(text, project)[name],
};

const sharedFixture: ConnectorFixture = {
  id: 'claude-code',
  title: 'Claude Code (--shared)',
  projectConfigAtRoot: true,
  create: () => createClaudeCodeConnector({ runClient: installed, configDirectory, shared: true }),
  createMissing: () =>
    createClaudeCodeConnector({
      configDirectory,
      shared: true,
      runClient: async () => {
        throw new Error('spawn claude ENOENT');
      },
    }),
  createForUser: (home) =>
    createClaudeCodeConnector({ runClient: installed, configDirectory: home }),
  userConfigPath: (home) => join(home, '.claude.json'),
  seedForeign: (root) =>
    writeJson(join(root, '.mcp.json'), {
      mcpServers: { 'their-server': { type: 'stdio', command: 'their-binary', args: ['--serve'] } },
      otherSetting: true,
    }),
  unrelatedSetting: (text) => parsed(text).otherSetting === true,
  seedImpostor: (root) =>
    writeJson(join(root, '.mcp.json'), {
      mcpServers: { lorepack: { type: 'stdio', command: 'someone-elses' } },
    }),
  serverNames: (text) => Object.keys(parsed(text).mcpServers ?? {}),
  entry: (text, name) => parsed(text).mcpServers?.[name],
};

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'lore-claude-'));
  configDirectory = mkdtempSync(join(tmpdir(), 'lore-claude-config-'));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(configDirectory, { recursive: true, force: true });
});

runConnectorContract(localFixture, () => project);
runConnectorContract(sharedFixture, () => project);
// The link refusal is about files inside the project, which only `--shared` writes. The local
// scope's file is the user's own, and its mode and links are covered below and by the user
// scope half of this suite.
runConfigFileSafetyContract(sharedFixture, () => project);

const connector = (extra: Parameters<typeof createClaudeCodeConnector>[0] = {}) =>
  createClaudeCodeConnector({ runClient: installed, configDirectory, probe: answers, ...extra });

describe('the local scope, where Claude Code actually reads it', () => {
  it('writes projects[<project>].mcpServers in .claude.json, and nothing in the project', async () => {
    const plan = await connector().plan(input());
    expect(plan.configPath).toBe(claudeJson());
    await connector().apply(plan);

    const document = parsed(readFileSync(claudeJson(), 'utf8'));
    const entry = localServers(readFileSync(claudeJson(), 'utf8'), project).lorepack as {
      command: string;
      args: string[];
    };
    expect(entry.command).toBe('lorepack');
    expect(entry.args).toContain('--ensure-current');
    expect(document.mcpServers).toBeUndefined();
    expect(existsSync(legacyPath(project))).toBe(false);
    expect(existsSync(join(project, '.mcp.json'))).toBe(false);
  });

  it('keeps every other project, user server and piece of client state', async () => {
    writeJson(claudeJson(), claudeState(project, {}));
    await connector().apply(await connector().plan(input()));

    const document = parsed(readFileSync(claudeJson(), 'utf8'));
    expect(document.numStartups).toBe(12);
    expect(document.mcpServers).toEqual({
      'a-user-server': { type: 'stdio', command: 'their-global' },
    });
    expect(document.projects['/some/other/project']).toEqual({ allowedTools: [], mcpServers: {} });
    expect(document.projects[claudeProjectKey(project)].allowedTools).toEqual(['Bash']);
  });

  it.skipIf(process.platform === 'win32')(
    'keys the project by its real path, as the client does',
    async () => {
      // Symlinks on Windows need administrator rights or Developer Mode.
      const link = join(configDirectory, 'linked-project');
      symlinkSync(project, link, 'dir');
      await connector().apply(await connector().plan(input({ projectRoot: link })));

      const projects = parsed(readFileSync(claudeJson(), 'utf8')).projects as Record<string, never>;
      expect(Object.keys(projects)).toEqual([realpathSync(project)]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps a private .claude.json private, because it holds the API key',
    async () => {
      // POSIX modes only: `chmod` on Windows toggles the read-only flag and nothing else.
      writeJson(claudeJson(), { primaryApiKey: 'sk-ant-test', ...claudeState(project, {}) });
      chmodSync(claudeJson(), 0o600);

      const receipt = await connector().apply(await connector().plan(input()));
      expect(statSync(claudeJson()).mode & 0o777).toBe(0o600);
      await connector().remove(receipt);
      expect(statSync(claudeJson()).mode & 0o777).toBe(0o600);
    },
  );

  it('takes back only this project entry, never another project or a user entry', async () => {
    const other = '/some/other/project';
    const ours = { type: 'stdio', command: 'lorepack' };
    writeJson(claudeJson(), {
      mcpServers: { lorepack: { ...ours, 'x-lorepack': { projectRoot: other, createdAt: 'x' } } },
      projects: {
        [other]: {
          mcpServers: {
            lorepack: { ...ours, 'x-lorepack': { projectRoot: other, createdAt: 'x' } },
          },
        },
      },
    });
    const receipt = await connector().apply(await connector().plan(input()));
    await connector().remove(receipt);

    const document = parsed(readFileSync(claudeJson(), 'utf8'));
    expect(document.projects[other].mcpServers.lorepack).toBeDefined();
    expect(document.mcpServers.lorepack).toBeDefined();
    expect(document.projects[claudeProjectKey(project)].mcpServers).toEqual({});
  });

  it('asks the client from the project directory, where a local server is listed', async () => {
    const asked: (string | undefined)[] = [];
    const listing = (stdout: string) =>
      connector({
        runClient: async (args, options) => {
          if (args[0] === 'mcp') asked.push(options?.cwd);
          return { stdout: args[0] === '--version' ? '2.1.296\n' : stdout, stderr: '' };
        },
      });

    const listed = listing('lorepack: lorepack mcp - ✓ Connected\n');
    const receipt = await listed.apply(await listed.plan(input()));
    expect((await listed.verify(receipt)).ok).toBe(true);
    expect(asked).toEqual([project]);

    const missing = await listing('No MCP servers configured.\n').verify(receipt);
    expect(missing.ok).toBe(false);
    expect(missing.step).toBe('trust');
    // Nothing to approve in the local scope, so the message must not send anyone looking for
    // an approval prompt that will never come.
    expect(missing.detail).not.toContain('approve');
    expect(missing.detail).toContain('claude mcp list');
  });
});

describe('where .claude.json lives', () => {
  it('is CLAUDE_CONFIG_DIR when it is set, and the home directory otherwise', () => {
    expect(claudeConfigDirectory({ CLAUDE_CONFIG_DIR: '/config' }, '/home/me')).toBe('/config');
    expect(claudeConfigDirectory({ CLAUDE_CONFIG_DIR: '' }, '/home/me')).toBe('/home/me');
    expect(claudeConfigDirectory({}, '/home/me')).toBe('/home/me');
  });

  it('follows CLAUDE_CONFIG_DIR by default, for the local and the user scope', async () => {
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDirectory;
    try {
      const fromEnvironment = createClaudeCodeConnector({ runClient: installed });
      expect((await fromEnvironment.plan(input())).configPath).toBe(claudeJson());
      expect((await fromEnvironment.plan(input({ scope: 'user' }))).configPath).toBe(claudeJson());
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

  it('puts the user scope in the top-level mcpServers', async () => {
    await connector().apply(await connector().plan(input({ scope: 'user' })));
    const document = parsed(readFileSync(claudeJson(), 'utf8'));
    expect(document.mcpServers.lorepack.command).toBe('lorepack');
    expect(document.projects).toBeUndefined();
  });
});

describe('an entry an earlier version wrote where Claude Code never looked', () => {
  const ownedLegacy = () => ({
    permissions: { allow: ['Bash(ls:*)'] },
    mcpServers: {
      lorepack: {
        type: 'stdio',
        command: 'lorepack',
        args: [],
        'x-lorepack': { projectRoot: project, createdAt: '2026-08-01T00:00:00.000Z' },
      },
    },
  });

  it('is named in the plan and removed on connect, leaving the settings', async () => {
    writeJson(legacyPath(project), ownedLegacy());

    const plan = await connector().plan(input());
    expect(plan.changes.join('\n')).toContain(
      `Remove the Lorepack entry an earlier version wrote to ${legacyPath(project)}`,
    );
    await connector().apply(plan);

    expect(parsed(readFileSync(legacyPath(project), 'utf8'))).toEqual({
      permissions: { allow: ['Bash(ls:*)'] },
    });
    expect(localServers(readFileSync(claudeJson(), 'utf8'), project).lorepack).toBeDefined();
  });

  it('is removed by disconnect too', async () => {
    writeJson(legacyPath(project), ownedLegacy());
    const plan = await connector().plan(input());
    await connector().remove({
      clientId: 'claude-code',
      scope: 'project',
      projectRoot: project,
      serverName: 'lorepack',
      configPath: plan.configPath,
      connectedAt: new Date().toISOString(),
    });
    expect(parsed(readFileSync(legacyPath(project), 'utf8')).mcpServers).toBeUndefined();
  });

  it('is left alone when someone else wrote it', async () => {
    const theirs = { mcpServers: { lorepack: { type: 'stdio', command: 'their-own' } } };
    writeJson(legacyPath(project), theirs);
    const before = readFileSync(legacyPath(project), 'utf8');

    const plan = await connector().plan(input());
    expect(plan.changes.join('\n')).not.toContain('earlier version');
    await connector().apply(plan);
    expect(readFileSync(legacyPath(project), 'utf8')).toBe(before);
  });

  it('does not block connecting when that settings file does not parse', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(legacyPath(project), '{ not json', 'utf8');

    await connector().apply(await connector().plan(input()));
    expect(readFileSync(legacyPath(project), 'utf8')).toBe('{ not json');
  });
});

describe('a .claude.json it cannot parse', () => {
  it('is refused rather than replaced', async () => {
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(claudeJson(), '{ this is not json', 'utf8');

    await expect(connector().plan(input())).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(claudeJson(), 'utf8')).toBe('{ this is not json');
  });
});

describe('the shared project file', () => {
  it('is never written unless asked for', async () => {
    const plan = await connector().plan(input());
    expect(plan.configPath).not.toContain('.mcp.json');
  });

  it('says a trust prompt is coming when it is', async () => {
    const plan = await connector({ shared: true }).plan(input());

    expect(plan.configPath).toBe(join(project, '.mcp.json'));
    // Not a failure, and not a surprise either: the file is checked in, so the client asks
    // each person to approve it.
    expect(plan.manualStep).toContain('approve');
  });
});

describe('the fallback for a version this adapter will not edit', () => {
  it('is a snippet a person can paste, containing the real command', () => {
    const snippet = claudeCodeSnippet(input());

    expect(() => JSON.parse(snippet)).not.toThrow();
    const document = parsed(snippet);
    expect(document.mcpServers.lorepack.command).toBe('lorepack');
    expect(document.mcpServers.lorepack.args).toContain('--ensure-current');
  });
});
