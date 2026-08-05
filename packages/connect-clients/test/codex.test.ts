import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexSnippet, createCodexConnector, projectTrust } from '../src/codex.js';
import type { ConnectInput } from '../src/port.js';
import { type ConnectorFixture, runConnectorContract } from './contract.js';

/**
 * The Codex adapter, against recorded `config.toml` shapes.
 *
 * The shared contract suite covers what would be a defect in any connector. What is here is
 * what is true of Codex alone, and every one of these was written from something measured
 * against `@openai/codex` 0.146.1 rather than from the documentation:
 *
 * - the project file is read **only in a trusted project**, and an untrusted one fails by
 *   showing an empty server list rather than an error;
 * - the file is TOML a person hand-edits, so a merge that loses their comments is a defect
 *   even though every JavaScript TOML library loses them on a round trip.
 *
 * The client binary is injected rather than found, so these say the same thing on a machine
 * with Codex installed and one without.
 */

let project: string;
let home: string;

const configPath = (root: string): string => join(root, '.codex', 'config.toml');

const installed = async () => ({ stdout: 'codex-cli 0.146.1\n', stderr: '' });

/** A server that starts and answers, so verification reaches the checks after the spawn. */
const answers = async () => ({ ok: true, step: 'none' as const, detail: 'Answered with 4 tools.' });

/** A hand-written configuration, with the comments and unrelated sections real ones have. */
const FOREIGN = `# Codex configuration, written by hand.
model = "gpt-5-codex"
otherSetting = true

# The sandbox settings took a while to get right. Do not change them.
[sandbox_workspace_write]
network_access = false

[mcp_servers.their-server]
command = "their-binary"
args = ["--serve"]

[mcp_servers.their-server.env]
THEIR_TOKEN = "abc"

[profiles.work]
model = "gpt-5-codex"
`;

const IMPOSTOR = `[mcp_servers.lorepack]
command = "someone-elses"
args = []
`;

function write(root: string, text: string): string {
  const path = configPath(root);
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return path;
}

function input(overrides: Partial<ConnectInput> = {}): ConnectInput {
  return {
    projectRoot: project,
    serverName: 'lorepack',
    command: { executable: 'lore', args: ['mcp', '--project', project, '--ensure-current'] },
    scope: 'project',
    ...overrides,
  };
}

const document = (text: string): Record<string, never> => parse(text) as Record<string, never>;

const fixture: ConnectorFixture = {
  id: 'codex',
  title: 'Codex',
  create: () => createCodexConnector({ runClient: installed, home }),
  createMissing: () =>
    createCodexConnector({
      home,
      runClient: async () => {
        throw new Error('spawn codex ENOENT');
      },
    }),
  seedForeign: (root) => write(root, FOREIGN),
  unrelatedSetting: (text) => document(text).otherSetting === true,
  seedImpostor: (root) => write(root, IMPOSTOR),
  serverNames: (text) => Object.keys(document(text).mcp_servers ?? {}),
  entry: (text, name) => (document(text).mcp_servers ?? {})[name],
};

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'lore-codex-'));
  home = mkdtempSync(join(tmpdir(), 'lore-codex-home-'));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

runConnectorContract(fixture, () => project);

describe('the file is a person\u2019s, and it stays theirs', () => {
  it('keeps every comment, every section and every blank line', async () => {
    const path = write(project, FOREIGN);
    const connector = createCodexConnector({ runClient: installed, home });
    await connector.apply(await connector.plan(input()));

    const after = readFileSync(path, 'utf8');
    // The specific failure this guards: a parse-then-stringify merge produces a valid file
    // with every one of these gone, and the user finds out weeks later.
    expect(after).toContain('# Codex configuration, written by hand.');
    expect(after).toContain(
      '# The sandbox settings took a while to get right. Do not change them.',
    );
    expect(after).toContain('[sandbox_workspace_write]');
    expect(after).toContain('[mcp_servers.their-server.env]');
    expect(after).toContain('[profiles.work]');
    // Everything that was there before our block is still there, untouched, in order.
    expect(after.startsWith(FOREIGN.slice(0, FOREIGN.indexOf('[profiles.work]')))).toBe(true);
  });

  it('leaves the file byte for byte as it was after connect then disconnect', async () => {
    const path = write(project, FOREIGN);
    const connector = createCodexConnector({ runClient: installed, home });

    const receipt = await connector.apply(await connector.plan(input()));
    await connector.remove(receipt);

    expect(readFileSync(path, 'utf8')).toBe(FOREIGN);
  });

  it('refuses a file it cannot parse rather than replacing it', async () => {
    const path = write(project, '[mcp_servers.broken\ncommand = "x"\n');
    const connector = createCodexConnector({ runClient: installed, home });

    await expect(connector.plan(input())).rejects.toThrow(/not valid TOML/);
    expect(readFileSync(path, 'utf8')).toBe('[mcp_servers.broken\ncommand = "x"\n');
  });

  /**
   * The one that only turned up while writing the ADR down, and the worst of the set.
   *
   * Measured: appending `[mcp_servers.lorepack]` to a file that already defines the same entry
   * with a dotted key redefines a table, and the whole `config.toml` then fails to parse. The
   * user's Codex stops loading entirely, over an entry they only wanted to replace.
   */
  it('refuses a file that declares our server without a table header', async () => {
    const path = write(project, '[mcp_servers]\nlorepack.command = "theirs"\n');
    const connector = createCodexConnector({ runClient: installed, home });

    await expect(connector.plan(input())).rejects.toThrow(/cannot edit without risking/);
    expect(readFileSync(path, 'utf8')).toBe('[mcp_servers]\nlorepack.command = "theirs"\n');
  });

  it('refuses a file whose mcp_servers is not a table of servers', async () => {
    write(project, 'mcp_servers = 3\n');
    const connector = createCodexConnector({ runClient: installed, home });

    // Valid TOML, and not a shape a server table can be spliced into. Writing anyway would
    // produce a document Codex cannot load at all.
    await expect(connector.plan(input())).rejects.toThrow(/other than a table of servers/);
  });

  it('writes a table, never a concatenated shell string, and escapes a Windows path', async () => {
    const windows = 'C:\\Users\\me\\a project';
    const connector = createCodexConnector({ runClient: installed, home });
    const receipt = await connector.apply(
      await connector.plan(
        input({
          projectRoot: project,
          command: { executable: 'lore', args: ['mcp', '--project', windows, '--ensure-current'] },
        }),
      ),
    );

    const text = readFileSync(receipt.configPath as string, 'utf8');
    expect(text).toContain('[mcp_servers.lorepack]');
    expect(text).toContain('args = ["mcp", "--project", "C:\\\\Users\\\\me\\\\a project"');
    // It has to survive a round trip through a real TOML parser as the original string.
    expect(fixture.entry(text, 'lorepack')?.args).toContain(windows);
  });
});

/**
 * Trust, which is the difference between a connector that works and one that reports success.
 *
 * Measured against Codex 0.146.1: in an untrusted project `codex mcp list --json` answers
 * `[]`. Nothing is broken, nothing is logged, and the agent simply never sees the server.
 */
describe('project trust', () => {
  const trust = (root: string): void =>
    writeFileSync(
      join(home, 'config.toml'),
      `[projects."${root.replace(/\\/g, '\\\\')}"]\ntrust_level = "trusted"\n`,
      'utf8',
    );

  it('is read from the Codex home configuration', () => {
    expect(projectTrust(home, project)).toBe('unknown');
    trust(project);
    expect(projectTrust(home, project)).toBe('trusted');
  });

  it('is named in the plan, before anything is written', async () => {
    const connector = createCodexConnector({ runClient: installed, home });
    const plan = await connector.plan(input());

    expect(plan.manualStep).toContain('trust');
    // And the other half of what a person needs to decide: the file is shareable.
    expect(plan.manualStep).toContain('commit');
  });

  it('stops saying the project is untrusted once it is', async () => {
    trust(project);
    const connector = createCodexConnector({ runClient: installed, home });
    const plan = await connector.plan(input());

    expect(plan.manualStep).toContain('commit');
    expect(plan.manualStep).not.toContain('not trusted yet');
  });

  it('is its own verification outcome, with the command that fixes it', async () => {
    const connector = createCodexConnector({ runClient: installed, home, probe: answers });
    const receipt = await connector.apply(await connector.plan(input()));
    const check = await connector.verify(receipt);

    // A working server in a project Codex will not read. Nothing is broken, so this is not a
    // failure of the server, and reporting it as one would send the user to the wrong side.
    expect(check.ok).toBe(false);
    expect(check.step).toBe('trust');
    expect(check.pendingTrust).toBe(true);
    expect(check.detail).toContain('trust the folder');
  });

  it('passes once the project is trusted and Codex lists the server', async () => {
    trust(project);
    const connector = createCodexConnector({
      home,
      probe: answers,
      runClient: async (args) =>
        args[0] === 'mcp'
          ? { stdout: '[{"name":"lorepack"}]', stderr: '' }
          : { stdout: 'codex-cli 0.146.1\n', stderr: '' },
    });

    const check = await connector.verify(await connector.apply(await connector.plan(input())));
    expect(check.ok).toBe(true);
  });

  it('reports a trusted project whose Codex still does not list the server', async () => {
    trust(project);
    const connector = createCodexConnector({
      home,
      probe: answers,
      // The measured shape of an untrusted or not-yet-restarted Codex: an empty list, no
      // error, nothing in the output to suggest anything is wrong.
      runClient: async (args) =>
        args[0] === 'mcp'
          ? { stdout: '[]', stderr: '' }
          : { stdout: 'codex-cli 0.146.1\n', stderr: '' },
    });

    const check = await connector.verify(await connector.apply(await connector.plan(input())));
    expect(check.ok).toBe(false);
    expect(check.step).toBe('trust');
    expect(check.pendingTrust).toBe(true);
  });

  it('trusts the protocol check when Codex itself cannot be asked', async () => {
    trust(project);
    const connector = createCodexConnector({
      home,
      probe: answers,
      runClient: async (args) => {
        if (args[0] === 'mcp') throw new Error('spawn codex ENOENT');
        return { stdout: 'codex-cli 0.146.1\n', stderr: '' };
      },
    });

    // Codex cannot be asked, which says nothing about whether the server works. The protocol
    // check is the evidence that matters, and inventing a failure from a missing binary would
    // send someone debugging a server that answers.
    const check = await connector.verify(await connector.apply(await connector.plan(input())));
    expect(check.ok).toBe(true);
  });

  it('does not apply to the user scope, which Codex always reads', async () => {
    const connector = createCodexConnector({ runClient: installed, home });
    const plan = await connector.plan(input({ scope: 'user' }));

    expect(plan.configPath).toBe(join(home, 'config.toml'));
    expect(plan.manualStep).toBeUndefined();
  });
});

describe('the fallback for a Codex this adapter will not edit', () => {
  it('is a TOML table a person can paste, containing the real command', () => {
    const snippet = codexSnippet(input());

    expect(() => parse(snippet)).not.toThrow();
    const table = document(snippet).mcp_servers.lorepack as {
      command: string;
      args: string[];
      cwd: string;
    };
    expect(table.command).toBe('lore');
    expect(table.args).toContain('--ensure-current');
    expect(table.cwd).toBe(project);
    // Nothing to remove later, so nothing claims ownership of it.
    expect(snippet).not.toContain('x-lorepack');
  });
});
