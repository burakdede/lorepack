import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCodeSnippet, createClaudeCodeConnector } from '../src/claude-code.js';
import { isOwned } from '../src/json-config.js';
import type { ConnectInput } from '../src/port.js';

/**
 * The Claude Code adapter, against recorded configuration shapes.
 *
 * The risk this guards is not "does it write a file". It is that the file it writes into
 * already belongs to someone: it holds servers they configured by hand, in a project they
 * will keep using afterwards. Architecture 24.8 names that as a real risk, and every test
 * below is a way of damaging it.
 *
 * The client binary is injected rather than found, so these say the same thing on a machine
 * with Claude Code installed and one without.
 */

let project: string;

/** A configuration that already has a server in it, which is the normal case. */
const EXISTING = {
  mcpServers: {
    'their-server': { type: 'stdio', command: 'their-binary', args: ['--serve'] },
  },
  otherSetting: true,
};

function input(overrides: Partial<ConnectInput> = {}): ConnectInput {
  return {
    projectRoot: project,
    serverName: 'lorepack',
    command: { executable: 'lore', args: ['mcp', '--project', project, '--ensure-current'] },
    scope: 'project',
    ...overrides,
  };
}

const installed = async () => ({ stdout: '1.2.3 (Claude Code)\n', stderr: '' });

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'lore-claude-'));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('detection', () => {
  it('reports the version the client gives', async () => {
    const connector = createClaudeCodeConnector({ runClient: installed });
    const detected = await connector.detect();

    expect(detected.installed).toBe(true);
    expect(detected.version).toContain('1.2.3');
    expect(detected.supported).toBe(true);
  });

  it('reports a missing client as not installed, rather than failing', async () => {
    const connector = createClaudeCodeConnector({
      runClient: async () => {
        throw new Error('spawn claude ENOENT');
      },
    });
    const detected = await connector.detect();

    // Not an error: a machine without Claude Code is an ordinary machine, and `lore connect`
    // has other clients and a snippet to offer.
    expect(detected.installed).toBe(false);
    expect(detected.reason).toContain('claude');
  });
});

/**
 * Status, which Studio's Diagnostics route asks for on every visit.
 *
 * Two properties matter and neither is about correctness of the answer: it must write
 * nothing, and it must distinguish an entry Lorepack created from one a person wrote by hand
 * under the same name. The second is the same distinction that keeps `lore disconnect` from
 * deleting someone else's server.
 */
describe('status', () => {
  it('reports not configured, and creates nothing by asking', async () => {
    const connector = createClaudeCodeConnector({ runClient: installed });
    const status = await connector.status(input());

    expect(status.installed).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.ownedByLorepack).toBe(false);
    expect(status.configPath).toBe(join(project, '.claude', 'settings.local.json'));
    // Opening a diagnostics page must never be a side effect on someone's configuration.
    expect(existsSync(join(project, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('reports an entry Lorepack created as its own', async () => {
    const connector = createClaudeCodeConnector({ runClient: installed });
    await connector.apply(await connector.plan(input()));

    const status = await connector.status(input());
    expect(status.configured).toBe(true);
    expect(status.ownedByLorepack).toBe(true);
  });

  it('reports an entry someone wrote by hand as theirs', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ mcpServers: { lorepack: { type: 'stdio', command: 'lore' } } }),
      'utf8',
    );

    const connector = createClaudeCodeConnector({ runClient: installed });
    const status = await connector.status(input());

    expect(status.configured).toBe(true);
    // Configured, but not by us. Claiming credit here is how `disconnect` later deletes
    // something it did not create.
    expect(status.ownedByLorepack).toBe(false);
  });
});

describe('planning, before anything is written', () => {
  it('names the file and the exact command, and writes nothing', async () => {
    const connector = createClaudeCodeConnector({ runClient: installed });
    const plan = await connector.plan(input());

    expect(plan.configPath).toBe(join(project, '.claude', 'settings.local.json'));
    expect(plan.changes.join('\n')).toContain('lore mcp --project');
    // `--dry-run` is the orchestrator's flag; the guarantee it depends on is that planning
    // itself never touches the disk.
    expect(existsSync(plan.configPath as string)).toBe(false);
  });

  it('defaults to the project, never the user scope', async () => {
    const connector = createClaudeCodeConnector({ runClient: installed });
    const plan = await connector.plan(input());

    // Architecture 6.6: a connector that quietly writes a user-scope entry configures every
    // project on the machine to read one project's documents.
    expect(plan.configPath).not.toContain('.claude.json');
    expect(plan.scope).toBe('project');
  });

  it('writes the shared file only when asked, and says a trust prompt is coming', async () => {
    const connector = createClaudeCodeConnector({ runClient: installed, shared: true });
    const plan = await connector.plan(input());

    expect(plan.configPath).toBe(join(project, '.mcp.json'));
    // Not a failure, and not a surprise either: the file is checked in, so the client asks
    // each person to approve it.
    expect(plan.manualStep).toContain('approve');
  });

  it('says it is updating, not adding, when Lorepack already configured this project', async () => {
    const connector = createClaudeCodeConnector({ runClient: installed });
    const first = await connector.plan(input());
    await connector.apply(first);

    const second = await connector.plan(input());
    expect(second.changes.join('\n')).toContain('Update the existing Lorepack server');
  });

  it('says plainly when it would replace a server it did not create', async () => {
    const path = join(project, '.claude', 'settings.local.json');
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { lorepack: { command: 'someone-elses' } } }),
      'utf8',
    );

    const connector = createClaudeCodeConnector({ runClient: installed });
    const plan = await connector.plan(input());

    // The user gets to see this before it happens, which is the entire purpose of a plan.
    expect(plan.changes.join('\n')).toContain('Lorepack did not create');
  });
});

describe('applying', () => {
  it('keeps every server that was already there', async () => {
    const path = join(project, '.claude', 'settings.local.json');
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(path, JSON.stringify(EXISTING), 'utf8');

    const connector = createClaudeCodeConnector({ runClient: installed });
    await connector.apply(await connector.plan(input()));

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, never>;
    expect(after.mcpServers['their-server']).toEqual(EXISTING.mcpServers['their-server']);
    expect(after.otherSetting).toBe(true);
    expect(after.mcpServers.lorepack).toBeDefined();
  });

  it('backs the file up before touching it', async () => {
    const path = join(project, '.claude', 'settings.local.json');
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(path, JSON.stringify(EXISTING), 'utf8');

    const connector = createClaudeCodeConnector({ runClient: installed });
    const receipt = await connector.apply(await connector.plan(input()));

    expect(receipt.backupPath).toBeDefined();
    expect(JSON.parse(readFileSync(receipt.backupPath as string, 'utf8'))).toEqual(EXISTING);
  });

  it('marks the entry as ours, which is what makes disconnect precise', async () => {
    const connector = createClaudeCodeConnector({ runClient: installed });
    const receipt = await connector.apply(await connector.plan(input()));

    const document = JSON.parse(readFileSync(receipt.configPath as string, 'utf8')) as Record<
      string,
      never
    >;
    expect(isOwned(document.mcpServers.lorepack, project)).toBe(true);
  });

  it('uses an absolute project path and --ensure-current, as an argument array', async () => {
    const connector = createClaudeCodeConnector({ runClient: installed });
    const receipt = await connector.apply(await connector.plan(input()));
    const document = JSON.parse(readFileSync(receipt.configPath as string, 'utf8')) as Record<
      string,
      never
    >;

    const entry = document.mcpServers.lorepack as { command: string; args: string[] };
    // An argument array rather than a concatenated string is what makes a path with a space
    // in it safe on every platform, which is the Windows quoting requirement in practice.
    expect(Array.isArray(entry.args)).toBe(true);
    expect(entry.args).toContain('--ensure-current');
    expect(entry.args).toContain(project);
  });

  it('is idempotent, so re-running fixes a stale path rather than duplicating anything', async () => {
    const connector = createClaudeCodeConnector({ runClient: installed });
    await connector.apply(await connector.plan(input()));
    const receipt = await connector.apply(await connector.plan(input()));

    const document = JSON.parse(readFileSync(receipt.configPath as string, 'utf8')) as Record<
      string,
      never
    >;
    expect(Object.keys(document.mcpServers)).toEqual(['lorepack']);
  });
});

describe('removing', () => {
  it('takes back the Lorepack entry and leaves the rest', async () => {
    const path = join(project, '.claude', 'settings.local.json');
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(path, JSON.stringify(EXISTING), 'utf8');

    const connector = createClaudeCodeConnector({ runClient: installed });
    const receipt = await connector.apply(await connector.plan(input()));
    await connector.remove(receipt);

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, never>;
    expect(after.mcpServers.lorepack).toBeUndefined();
    expect(after.mcpServers['their-server']).toEqual(EXISTING.mcpServers['their-server']);
  });

  it('leaves an entry of the same name that someone else wrote', async () => {
    const path = join(project, '.claude', 'settings.local.json');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const theirs = { mcpServers: { lorepack: { command: 'their-own-thing' } } };
    writeFileSync(path, JSON.stringify(theirs), 'utf8');

    const connector = createClaudeCodeConnector({ runClient: installed });
    await connector.remove({
      clientId: 'claude-code',
      scope: 'project',
      serverName: 'lorepack',
      configPath: path,
      connectedAt: new Date().toISOString(),
    });

    // Deleting it because the name matched would be exactly the corruption the ownership
    // marker exists to prevent.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(theirs);
  });

  it('does nothing at all when there is no file', async () => {
    const connector = createClaudeCodeConnector({ runClient: installed });
    await expect(
      connector.remove({
        clientId: 'claude-code',
        scope: 'project',
        serverName: 'lorepack',
        configPath: join(project, 'nothing-here.json'),
        connectedAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('the fallback for a version this adapter will not edit', () => {
  it('is a snippet a person can paste, containing the real command', () => {
    const snippet = claudeCodeSnippet(input());

    expect(() => JSON.parse(snippet)).not.toThrow();
    const parsed = JSON.parse(snippet) as Record<string, never>;
    expect(parsed.mcpServers.lorepack.command).toBe('lore');
    expect(parsed.mcpServers.lorepack.args).toContain('--ensure-current');
  });
});
