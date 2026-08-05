import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { backup } from './json-config.js';
import {
  ownerOfEntry,
  readJsoncConfig,
  withOwnedEntry,
  withoutOwnedEntry,
} from './jsonc-config.js';
import type {
  ClientConnector,
  ClientDetection,
  ClientStatus,
  ConnectInput,
  ConnectionCheck,
  ConnectPlan,
  ConnectReceipt,
} from './port.js';
import { writeTextAtomically } from './toml-config.js';
import { type VerifyOptions, verifyStdioServer } from './verify.js';

/**
 * VS Code, the third supported client.
 *
 * Everything below was verified against **1.132.0**, downloaded and run rather than read
 * about, and two of the ticket's assumptions did not survive that.
 *
 * ## `code --add-mcp` writes the user profile, and cannot be told not to
 *
 * Its own help says so: *"Adds a Model Context Protocol server definition to the **user**
 * profile"*. It has no workspace option. Architecture 6.6 says Lorepack never chooses the user
 * profile silently and defaults to the workspace, so the CLI cannot express the scope we
 * default to, and step 5's preference resolves to editing the file ourselves.
 *
 * Measured while confirming that: it writes `<user-data-dir>/User/mcp.json`, and it resolves
 * the user profile from the real home even when `$HOME` points somewhere else, so nothing here
 * may call it. `--version` is the only invocation this adapter makes.
 *
 * ## Doing better than the client's own tool is the reason to write the file at all
 *
 * Given a hand-written `mcp.json` with comments, `code --add-mcp` deleted every comment,
 * reformatted the whole document, and added `"type": "stdio"` to a server the user had
 * configured themselves. That is exactly the quiet damage architecture 24.8 is about, and it
 * is why [`jsonc-config.ts`](./jsonc-config.ts) edits minimally instead.
 */

const execute = promisify(execFile);

export const VSCODE_ID = 'vscode';

/** The top-level key VS Code reads. Not `mcpServers`, which is the Claude-style name. */
const SERVERS_KEY = 'servers';

export interface VsCodeOptions {
  /** Overridden in tests, so detection does not depend on the developer's machine. */
  readonly runClient?: (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  /** The user profile directory, for `--scope user`. */
  readonly userConfigDirectory?: string;
  /** How to find out whether the configured server answers. Injected the same way. */
  readonly probe?: (options: VerifyOptions) => Promise<ConnectionCheck>;
}

/**
 * Where VS Code keeps the user profile's `mcp.json` on each platform.
 *
 * Only reachable through an explicit `--scope user`. A user-profile entry configures every
 * window on the machine to read one project's documents, which for a private corpus is worse
 * than merely surprising, so `connect all` never arrives here.
 */
export function userConfigDirectory(home = homedir(), platform = process.platform): string {
  if (platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Code', 'User');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User');
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Code', 'User');
}

function configPathFor(
  projectRoot: string,
  scope: ConnectInput['scope'],
  userDirectory: string,
): string {
  if (scope === 'user') return join(userDirectory, 'mcp.json');
  return join(projectRoot, '.vscode', 'mcp.json');
}

export function createVsCodeConnector(options: VsCodeOptions = {}): ClientConnector {
  const userDirectory = options.userConfigDirectory ?? userConfigDirectory();
  const probe = options.probe ?? verifyStdioServer;
  const runClient =
    options.runClient ??
    (async (args: readonly string[]) => {
      const { stdout, stderr } = await execute('code', [...args], { timeout: 20_000 });
      return { stdout, stderr };
    });

  const entryPath = (serverName: string): readonly string[] => [SERVERS_KEY, serverName];

  return {
    id: VSCODE_ID,
    title: 'VS Code',

    async detect(): Promise<ClientDetection> {
      try {
        // `code --version` prints three lines: version, commit, architecture.
        const { stdout } = await runClient(['--version']);
        return {
          installed: true,
          version: stdout.trim().split('\n')[0] ?? '',
          supported: true,
        };
      } catch (error) {
        return {
          installed: false,
          supported: false,
          reason: `The \`code\` command was not found: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },

    async status(input: ConnectInput): Promise<ClientStatus> {
      const detected = await this.detect();
      const path = configPathFor(input.projectRoot, input.scope, userDirectory);

      // Reads the file and nothing else. Studio's Diagnostics route calls this on every visit.
      const config = readJsoncConfig(path);
      const owner = ownerOfEntry(config.text, entryPath(input.serverName));

      return {
        ...detected,
        configPath: path,
        configured: serverEntry(config.document, input.serverName) !== undefined,
        ownedByLorepack: owner !== undefined && owner.projectRoot === input.projectRoot,
      };
    },

    async plan(input: ConnectInput): Promise<ConnectPlan> {
      const path = configPathFor(input.projectRoot, input.scope, userDirectory);
      const config = readJsoncConfig(path);
      assertServersIsAnObject(config.document, path);

      const entry = {
        type: 'stdio',
        command: input.command.executable,
        args: [...input.command.args],
        // `sandboxEnabled` is deliberately absent. VS Code's schema gives it `default: false`,
        // so omitting it is exactly unsandboxed, and turning it on cannot be claimed as
        // supported without driving the real sandbox: `--ensure-current` writes `.lore/` on
        // first run, which is precisely what a filesystem sandbox would stop. Shipping it on
        // an untested guess would turn a working connect into a server that starts and fails.
      };

      const existing = serverEntry(config.document, input.serverName);
      const owner = ownerOfEntry(config.text, entryPath(input.serverName));

      const changes: string[] = [];
      if (existing === undefined) {
        changes.push(`Add an MCP server named ${input.serverName} to ${path}`);
      } else if (owner !== undefined && owner.projectRoot === input.projectRoot) {
        changes.push(`Update the existing Lorepack server in ${path}`);
      } else {
        changes.push(
          `Replace a server named ${input.serverName} in ${path} that Lorepack did not create`,
        );
      }
      changes.push(`  ${input.command.executable} ${input.command.args.join(' ')}`);
      changes.push('  Every other server, setting and comment in that file is left as it is.');

      return {
        clientId: VSCODE_ID,
        scope: input.scope,
        projectRoot: input.projectRoot,
        configPath: path,
        changes,
        entry,
        serverName: input.serverName,
        ...(input.scope === 'project'
          ? {
              manualStep:
                'This writes `.vscode/mcp.json`, which is shareable, source-controlled configuration: committing it gives every teammate this server. VS Code also asks you to confirm you trust the server the first time it starts, and chat runs without these tools until you do.',
            }
          : {}),
      };
    },

    async apply(plan: ConnectPlan): Promise<ConnectReceipt> {
      const path = plan.configPath;
      if (path === null) throw new Error('This plan has no file to write.');

      const config = readJsoncConfig(path);
      const backupPath = backup(path);
      const text = withOwnedEntry(config, {
        path: entryPath(plan.serverName),
        projectRoot: plan.projectRoot,
        value: plan.entry,
        removeWith: 'lore disconnect vscode',
      });
      writeTextAtomically(path, text);

      return {
        clientId: VSCODE_ID,
        scope: plan.scope,
        projectRoot: plan.projectRoot,
        serverName: plan.serverName,
        configPath: path,
        ...(backupPath === undefined ? {} : { backupPath }),
        connectedAt: new Date().toISOString(),
      };
    },

    async verify(receipt: ConnectReceipt): Promise<ConnectionCheck> {
      const path = receipt.configPath;
      if (path === null || !existsSync(path)) {
        return { ok: false, step: 'spawn', detail: `${path} was not written.` };
      }

      const config = readJsoncConfig(path);
      const entry = serverEntry(config.document, receipt.serverName);
      if (entry?.command === undefined) {
        return { ok: false, step: 'spawn', detail: `No ${receipt.serverName} entry in ${path}.` };
      }

      // Spawned exactly as VS Code will spawn it, which is the only way to learn that the
      // command in the file does not actually start.
      const check = await probe({ executable: entry.command, args: entry.args ?? [] });
      if (!check.ok) return check;

      // VS Code has no way to be asked what it has loaded from outside the editor, so the
      // trust step is reported as the outstanding one rather than guessed at. It is not a
      // failure: the file is right and one confirmation remains.
      return {
        ...check,
        detail: `${check.detail} VS Code will ask you to confirm you trust this server the first time it starts; run \`MCP: List Servers\` from the Command Palette to see it.`,
      };
    },

    async remove(receipt: ConnectReceipt): Promise<void> {
      const path = receipt.configPath;
      if (path === null || !existsSync(path)) return;

      const config = readJsoncConfig(path);
      const { text, removed } = withoutOwnedEntry(config, entryPath(receipt.serverName));
      if (!removed) return;

      backup(path);
      writeTextAtomically(path, text);
    },
  };
}

/**
 * Refuses a file whose `servers` is not an object.
 *
 * `"servers": [1, 2]` is valid JSON, and `jsonc-parser` throws rather than splicing into it.
 * Catching it here turns a stack trace into a sentence naming the file.
 */
function assertServersIsAnObject(document: Record<string, unknown>, path: string): void {
  const servers = document[SERVERS_KEY];
  if (servers === undefined) return;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new Error(
      `${path} declares \`${SERVERS_KEY}\` as something other than an object of servers, so it will not be edited.`,
    );
  }
}

function serverEntry(
  document: Record<string, unknown>,
  serverName: string,
): { command?: string; args?: string[] } | undefined {
  const servers = document[SERVERS_KEY];
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return undefined;
  const entry = (servers as Record<string, unknown>)[serverName];
  if (typeof entry !== 'object' || entry === null) return undefined;
  return entry as { command?: string; args?: string[] };
}

/**
 * The copy-paste fallback, for a VS Code this adapter will not edit.
 *
 * No ownership comment: nothing is being removed later, so what the user pastes is theirs.
 */
export function vsCodeSnippet(input: ConnectInput): string {
  return `${JSON.stringify(
    {
      [SERVERS_KEY]: {
        [input.serverName]: {
          type: 'stdio',
          command: input.command.executable,
          args: [...input.command.args],
        },
      },
    },
    null,
    2,
  )}\n`;
}
