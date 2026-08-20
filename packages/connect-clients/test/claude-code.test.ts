import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCodeSnippet, createClaudeCodeConnector } from '../src/claude-code.js';
import type { ConnectInput } from '../src/port.js';
import { type ConnectorFixture, runConnectorContract } from './contract.js';

/**
 * The Claude Code adapter.
 *
 * Everything that would be a defect in *any* connector lives in the shared contract suite, so
 * what remains here is what is true of this client alone: the `--shared` project file that
 * others are asked to trust, and the shape of the snippet.
 */

let project: string;

const CONFIG = ['.claude', 'settings.local.json'];
const pathIn = (root: string): string => join(root, ...CONFIG);

const installed = async () => ({ stdout: '1.2.3 (Claude Code)\n', stderr: '' });

function input(overrides: Partial<ConnectInput> = {}): ConnectInput {
  return {
    projectRoot: project,
    serverName: 'lorepack',
    command: { executable: 'lore', args: ['mcp', '--project', project, '--ensure-current'] },
    scope: 'project',
    ...overrides,
  };
}

function write(root: string, document: unknown): string {
  const path = pathIn(root);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return path;
}

const parsed = (text: string): Record<string, never> => JSON.parse(text) as Record<string, never>;

const fixture: ConnectorFixture = {
  id: 'claude-code',
  title: 'Claude Code',
  create: () => createClaudeCodeConnector({ runClient: installed }),
  createMissing: () =>
    createClaudeCodeConnector({
      runClient: async () => {
        throw new Error('spawn claude ENOENT');
      },
    }),
  seedForeign: (root) =>
    write(root, {
      mcpServers: { 'their-server': { type: 'stdio', command: 'their-binary', args: ['--serve'] } },
      otherSetting: true,
    }),
  unrelatedSetting: (text) => parsed(text).otherSetting === true,
  seedImpostor: (root) =>
    write(root, { mcpServers: { lorepack: { type: 'stdio', command: 'someone-elses' } } }),
  serverNames: (text) => Object.keys(parsed(text).mcpServers ?? {}),
  entry: (text, name) => parsed(text).mcpServers?.[name],
};

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'lore-claude-'));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

runConnectorContract(fixture, () => project);

describe('the shared project file, which is this client alone', () => {
  it('is never written unless asked for', async () => {
    const plan = await createClaudeCodeConnector({ runClient: installed }).plan(input());

    expect(plan.configPath).toBe(pathIn(project));
    expect(plan.configPath).not.toContain('.mcp.json');
  });

  it('says a trust prompt is coming when it is', async () => {
    const connector = createClaudeCodeConnector({ runClient: installed, shared: true });
    const plan = await connector.plan(input());

    expect(plan.configPath).toBe(join(project, '.mcp.json'));
    // Not a failure, and not a surprise either: the file is checked in, so the client asks
    // each person to approve it.
    expect(plan.manualStep).toContain('approve');
  });

  it('refuses a file it cannot parse rather than replacing it', async () => {
    const path = pathIn(project);
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(path, '{ this is not json', 'utf8');

    const connector = createClaudeCodeConnector({ runClient: installed });
    await expect(connector.plan(input())).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{ this is not json');
    expect(existsSync(`${path}.bak`)).toBe(false);
  });
});

describe('the fallback for a version this adapter will not edit', () => {
  it('is a snippet a person can paste, containing the real command', () => {
    const snippet = claudeCodeSnippet(input());

    expect(() => JSON.parse(snippet)).not.toThrow();
    const document = parsed(snippet);
    expect(document.mcpServers.lorepack.command).toBe('lore');
    expect(document.mcpServers.lorepack.args).toContain('--ensure-current');
  });
});
