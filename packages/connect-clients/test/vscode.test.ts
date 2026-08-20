import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectInput } from '../src/port.js';
import { createVsCodeConnector, userConfigDirectory, vsCodeSnippet } from '../src/vscode.js';
import { type ConnectorFixture, runConnectorContract } from './contract.js';

/**
 * The VS Code adapter, against recorded `.vscode/mcp.json` shapes.
 *
 * The shared contract suite covers what must be true of any connector. What is here was
 * written from things measured against VS Code **1.132.0**, downloaded and run:
 *
 * - the top-level key is `servers`, not `mcpServers`, and writing the wrong one produces a
 *   file VS Code silently ignores;
 * - the file is JSONC, declared so by VS Code's own schema, so a comment in it is legal and
 *   `JSON.parse` would refuse a perfectly good configuration;
 * - the schema for a server is `additionalProperties: false`, which is why ownership is a
 *   comment and not a key;
 * - `code --add-mcp` writes the **user profile**, deletes every comment in the file, and adds
 *   `"type": "stdio"` to servers the user configured. The adapter must beat that, and the
 *   round-trip test is what proves it.
 */

let project: string;
let userDirectory: string;

const configPath = (root: string): string => join(root, '.vscode', 'mcp.json');

const installed = async () => ({
  stdout: '1.132.0\ndf53daabb18cd157bdb08c7f01c34df936cf12f4\nx64\n',
  stderr: '',
});

/** A server that starts and answers, so verification reaches what comes after the spawn. */
const answers = async () => ({ ok: true, step: 'none' as const, detail: 'Answered with 4 tools.' });

/** A hand-written configuration, with the comments and formatting real ones have. */
const FOREIGN = `{
\t// My notes server. Took ages to get the args right.
\t"servers": {
\t\t"their-server": {
\t\t\t"command": "their-binary",
\t\t\t"args": ["--serve"] // do not change
\t\t}
\t},
\t"inputs": [],
\t"otherSetting": true
}
`;

const IMPOSTOR = `{
\t"servers": {
\t\t"lorepack": {
\t\t\t"command": "someone-elses"
\t\t}
\t}
}
`;

function write(root: string, text: string): string {
  const path = configPath(root);
  mkdirSync(join(root, '.vscode'), { recursive: true });
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

const document = (text: string): Record<string, never> =>
  parse(text, [], { allowTrailingComma: true }) as Record<string, never>;

const fixture: ConnectorFixture = {
  id: 'vscode',
  title: 'VS Code',
  create: () => createVsCodeConnector({ runClient: installed, userConfigDirectory: userDirectory }),
  createMissing: () =>
    createVsCodeConnector({
      userConfigDirectory: userDirectory,
      runClient: async () => {
        throw new Error('spawn code ENOENT');
      },
    }),
  seedForeign: (root) => write(root, FOREIGN),
  unrelatedSetting: (text) => document(text).otherSetting === true,
  seedImpostor: (root) => write(root, IMPOSTOR),
  serverNames: (text) => Object.keys(document(text).servers ?? {}),
  entry: (text, name) => document(text).servers?.[name],
};

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'lore-vscode-'));
  userDirectory = mkdtempSync(join(tmpdir(), 'lore-vscode-user-'));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(userDirectory, { recursive: true, force: true });
});

runConnectorContract(fixture, () => project);

describe('the key VS Code actually reads', () => {
  it('is `servers`, and never `mcpServers`', async () => {
    const connector = fixture.create(project);
    const receipt = await connector.apply(await connector.plan(input()));
    const text = readFileSync(receipt.configPath as string, 'utf8');

    // The wrong key produces a file VS Code ignores without a word, which looks exactly like
    // a connect that worked until somebody asks their agent a question.
    expect(text).toContain('"servers"');
    expect(text).not.toContain('mcpServers');
    expect(document(text).servers.lorepack).toBeDefined();
  });

  it('declares the stdio type explicitly', async () => {
    const connector = fixture.create(project);
    const receipt = await connector.apply(await connector.plan(input()));

    expect(
      fixture.entry(readFileSync(receipt.configPath as string, 'utf8'), 'lorepack'),
    ).toMatchObject({ type: 'stdio', command: 'lore' });
  });

  /**
   * VS Code's schema gives `sandboxEnabled` `default: false`, so leaving it out is exactly
   * unsandboxed. Turning it on cannot be claimed as supported without driving the real
   * sandbox, and `--ensure-current` writes `.lore/` on first run, which is what a filesystem
   * sandbox would stop.
   */
  it('leaves sandboxEnabled unset rather than guessing at it', async () => {
    const connector = fixture.create(project);
    const receipt = await connector.apply(await connector.plan(input()));
    const written = fixture.entry(readFileSync(receipt.configPath as string, 'utf8'), 'lorepack');

    expect(Object.keys(written as object)).toEqual(['type', 'command', 'args']);
  });
});

describe("the file is a person's, and it stays theirs", () => {
  it('keeps every comment, and does not touch a server they configured', async () => {
    const path = write(project, FOREIGN);
    const connector = fixture.create(project);
    await connector.apply(await connector.plan(input()));

    const after = readFileSync(path, 'utf8');
    // Measured: `code --add-mcp` deletes both of these and adds `"type"` to their server.
    expect(after).toContain('// My notes server. Took ages to get the args right.');
    expect(after).toContain('"args": ["--serve"] // do not change');
    expect(after).toContain('"otherSetting": true');
    expect(fixture.entry(after, 'their-server')).not.toHaveProperty('type');
  });

  it('leaves the file byte for byte as it was after connect then disconnect', async () => {
    const path = write(project, FOREIGN);
    const connector = fixture.create(project);

    const receipt = await connector.apply(await connector.plan(input()));
    await connector.remove(receipt);

    expect(readFileSync(path, 'utf8')).toBe(FOREIGN);
  });

  it('matches the indentation the file already uses', async () => {
    const path = write(
      project,
      '{\n  "servers": {\n    "their-server": {\n      "command": "x"\n    }\n  }\n}\n',
    );
    const connector = fixture.create(project);
    await connector.apply(await connector.plan(input()));

    // Editing a two-space file with tab settings reindents their entries and leaves the
    // document mixed, which shows up as a whole-file diff in somebody's next commit.
    expect(readFileSync(path, 'utf8')).not.toContain('\t');
  });

  it('refuses a file it cannot parse rather than replacing it', async () => {
    const damaged = '{\n\t"servers": \n';
    const path = write(project, damaged);
    const connector = fixture.create(project);

    // The specific trap: `jsonc-parser` does not throw on this, it returns `{}`. An adapter
    // that ignored the errors array would decide the file has no servers and write a fresh
    // one over a file that was missing a brace.
    await expect(connector.plan(input())).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe(damaged);
  });

  it('refuses a file whose servers is not an object', async () => {
    write(project, '{ "servers": [1, 2] }');
    const connector = fixture.create(project);

    await expect(connector.plan(input())).rejects.toThrow(/other than an object of servers/);
  });

  it('reads a configuration whose only oddity is a trailing comma', async () => {
    write(project, '{\n\t"servers": {\n\t\t"their-server": { "command": "x" },\n\t},\n}\n');
    const connector = fixture.create(project);

    // VS Code's schema sets `allowTrailingCommas: true`, so this is a valid file and refusing
    // it would be us being stricter than the client we are configuring.
    const plan = await connector.plan(input());
    expect(plan.changes.join('\n')).toContain('Add an MCP server');
  });
});

describe('scope, which is where a private corpus leaks', () => {
  it('defaults to the workspace and says it is shareable', async () => {
    const plan = await fixture.create(project).plan(input());

    expect(plan.configPath).toBe(configPath(project));
    expect(plan.manualStep).toContain('source-controlled');
    // The other half of what a person needs to expect afterwards.
    expect(plan.manualStep).toContain('trust');
  });

  it('touches the user profile only when explicitly asked', async () => {
    const connector = fixture.create(project);
    const plan = await connector.plan(input({ scope: 'user' }));

    expect(plan.configPath).toBe(join(userDirectory, 'mcp.json'));
    // Nothing shareable about a profile file, and no teammate to warn.
    expect(plan.manualStep).toBeUndefined();
  });

  it('knows where the profile lives on each platform', () => {
    expect(userConfigDirectory('/home/me', 'linux')).toContain(join('Code', 'User'));
    expect(userConfigDirectory('/Users/me', 'darwin')).toBe(
      join('/Users/me', 'Library', 'Application Support', 'Code', 'User'),
    );
    expect(userConfigDirectory('C:\\Users\\me', 'win32')).toContain(join('Code', 'User'));
  });
});

describe('verification', () => {
  it('names the trust confirmation that is still outstanding', async () => {
    const connector = createVsCodeConnector({
      runClient: installed,
      userConfigDirectory: userDirectory,
      probe: answers,
    });
    const check = await connector.verify(await connector.apply(await connector.plan(input())));

    // Not a failure: the file is right and one confirmation remains. VS Code cannot be asked
    // from outside the editor what it has loaded, so the honest answer names the step.
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('trust this server');
    expect(check.detail).toContain('MCP: List Servers');
  });

  it('reports a server that does not start as a spawn failure', async () => {
    const connector = createVsCodeConnector({
      runClient: installed,
      userConfigDirectory: userDirectory,
      probe: async () => ({ ok: false, step: 'spawn' as const, detail: 'spawn lore ENOENT' }),
    });
    const check = await connector.verify(await connector.apply(await connector.plan(input())));

    expect(check.ok).toBe(false);
    expect(check.step).toBe('spawn');
  });
});

describe('the fallback for a version this adapter will not edit', () => {
  it('is a snippet a person can paste, using the key VS Code reads', () => {
    const snippet = vsCodeSnippet(input());

    expect(() => JSON.parse(snippet)).not.toThrow();
    const parsed = JSON.parse(snippet) as Record<string, never>;
    expect(parsed.servers.lorepack.type).toBe('stdio');
    expect(parsed.servers.lorepack.args).toContain('--ensure-current');
    expect(snippet).not.toContain('x-lorepack');
  });
});
