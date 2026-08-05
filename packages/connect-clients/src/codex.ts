import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { backup } from './json-config.js';
import type {
  ClientConnector,
  ClientDetection,
  ClientStatus,
  ConnectInput,
  ConnectionCheck,
  ConnectPlan,
  ConnectReceipt,
} from './port.js';
import {
  ownerOfTable,
  readTomlConfig,
  renderOwnedTable,
  tableSpan,
  tomlString,
  withoutTomlTable,
  withTomlTable,
  writeTextAtomically,
} from './toml-config.js';
import { type VerifyOptions, verifyStdioServer } from './verify.js';

/**
 * Codex, the second supported client, and the first whose configuration is not JSON.
 *
 * Everything below was verified by installing `@openai/codex` **0.146.1** and running it
 * against a temporary `CODEX_HOME`, on 2026-08-05. The ticket was written from the published
 * documentation and two of its assumptions did not survive that:
 *
 * ## The official CLI cannot express the scope we default to
 *
 * Architecture 6.6 step 5 says to prefer the client's own CLI when it can express the chosen
 * scope safely. `codex mcp add` cannot: it has **no scope flag**, it writes
 * `$CODEX_HOME/config.toml`, and it says so, answering `Added global MCP server 'lorepack'`.
 * Lorepack's default is the project, so the CLI is out on the write path for the default and
 * is not used for the user scope either, because it offers no way to attach the ownership
 * marker that makes `disconnect` remove exactly our entry and nothing else.
 *
 * It is used where it is authoritative and harmless: `codex --version` for detection, and
 * `codex mcp list --json` run **from the project directory** for verification.
 *
 * ## Project trust is a precondition, and its failure is silent
 *
 * Codex reads `.codex/config.toml` only in a project the user has trusted, recorded in
 * `$CODEX_HOME/config.toml` as `[projects."<path>"] trust_level = "trusted"`. Measured: in an
 * untrusted project, `codex mcp list --json` answers `[]`. Not an error, not a warning, just
 * an empty list. A connector that did not check this would write a correct file, report
 * success, and leave the user with an agent that has never heard of their documents.
 *
 * So trust has its own outcome. It is not a failure, because nothing is broken: the file is
 * right and one interactive step remains.
 */

const execute = promisify(execFile);

export const CODEX_ID = 'codex';

/** The container Codex declares its servers in. Note the underscore, not a hyphen. */
const SERVERS_KEY = 'mcp_servers';

export interface CodexOptions {
  /** Overridden in tests, so detection does not depend on the developer's machine. */
  readonly runClient?: (
    args: readonly string[],
    options?: { readonly cwd?: string },
  ) => Promise<{ stdout: string; stderr: string }>;
  /** `CODEX_HOME`, which is where user scope and the trust record both live. */
  readonly home?: string;
  /**
   * How to find out whether the configured server answers. Injected for the same reason
   * `runClient` is: the trust branch is only reachable once something has started, and a test
   * that could not reach it would leave the silent failure this adapter exists to catch
   * covered by nothing.
   */
  readonly probe?: (options: VerifyOptions) => Promise<ConnectionCheck>;
}

function codexHome(options: CodexOptions): string {
  return options.home ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

/**
 * Where each scope stores its servers.
 *
 * `project` is architecture 6.6's *workspace* scope under the name the rest of the CLI already
 * uses. There is deliberately no third scope word: one concept with two names is worse than a
 * mapping recorded in one place, and this is that place.
 */
function configPathFor(projectRoot: string, scope: ConnectInput['scope'], home: string): string {
  if (scope === 'user') return join(home, 'config.toml');
  return join(projectRoot, '.codex', 'config.toml');
}

/** Whether the user has trusted this project, which decides if the file is read at all. */
export function projectTrust(home: string, projectRoot: string): 'trusted' | 'unknown' {
  const path = join(home, 'config.toml');
  if (!existsSync(path)) return 'unknown';

  let document: Record<string, unknown>;
  try {
    document = readTomlConfig(path).document;
  } catch {
    // Their global configuration does not parse. That is their problem to see in Codex's own
    // error, not something to guess around here.
    return 'unknown';
  }

  const projects = document.projects;
  if (typeof projects !== 'object' || projects === null) return 'unknown';
  const entry = (projects as Record<string, unknown>)[projectRoot];
  if (typeof entry !== 'object' || entry === null) return 'unknown';
  return (entry as { trust_level?: unknown }).trust_level === 'trusted' ? 'trusted' : 'unknown';
}

export function createCodexConnector(options: CodexOptions = {}): ClientConnector {
  const home = codexHome(options);
  const probe = options.probe ?? verifyStdioServer;
  const runClient =
    options.runClient ??
    (async (args: readonly string[], run?: { cwd?: string }) => {
      const { stdout, stderr } = await execute('codex', [...args], {
        timeout: 20_000,
        ...(run?.cwd === undefined ? {} : { cwd: run.cwd }),
        env: { ...process.env, CODEX_HOME: home },
      });
      return { stdout, stderr };
    });

  const tablePath = (serverName: string): readonly string[] => [SERVERS_KEY, serverName];

  return {
    id: CODEX_ID,
    title: 'Codex',

    async detect(): Promise<ClientDetection> {
      try {
        const { stdout } = await runClient(['--version']);
        return {
          installed: true,
          version: stdout.trim().split('\n')[0] ?? '',
          // Supported by shape rather than by version number: the adapter refuses at plan
          // time to merge into a file it cannot parse, which is a real check, where a version
          // allowlist is a guess that goes stale the week after it is written.
          supported: true,
        };
      } catch (error) {
        return {
          installed: false,
          supported: false,
          reason: `The \`codex\` command was not found: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },

    async status(input: ConnectInput): Promise<ClientStatus> {
      const detected = await this.detect();
      const path = configPathFor(input.projectRoot, input.scope, home);

      // Reads the file and nothing else. Studio's Diagnostics route calls this on every visit,
      // and opening a page must never write a configuration or spawn a server.
      const config = readTomlConfig(path);
      const span = tableSpan(config.text, tablePath(input.serverName));
      const owner = ownerOfTable(config.text, tablePath(input.serverName));

      return {
        ...detected,
        configPath: path,
        configured: span !== undefined,
        ownedByLorepack: owner !== undefined && owner.projectRoot === input.projectRoot,
      };
    },

    async plan(input: ConnectInput): Promise<ConnectPlan> {
      const path = configPathFor(input.projectRoot, input.scope, home);
      const config = readTomlConfig(path);
      assertServersAreTables(config.document, path);
      assertEditable(config.text, config.document, input.serverName, path);

      const block = renderOwnedTable({
        path: tablePath(input.serverName),
        projectRoot: input.projectRoot,
        values: {
          command: input.command.executable,
          args: [...input.command.args],
          cwd: input.projectRoot,
        },
      });

      const span = tableSpan(config.text, tablePath(input.serverName));
      const owner = ownerOfTable(config.text, tablePath(input.serverName));

      const changes: string[] = [];
      if (span === undefined) {
        changes.push(`Add an MCP server named ${input.serverName} to ${path}`);
      } else if (owner !== undefined && owner.projectRoot === input.projectRoot) {
        // Idempotent: re-running is how someone fixes a stale path, and it should read as a
        // routine update rather than as something going wrong.
        changes.push(`Update the existing Lorepack server in ${path}`);
      } else {
        changes.push(
          `Replace a server named ${input.serverName} in ${path} that Lorepack did not create`,
        );
      }
      changes.push(`  ${input.command.executable} ${input.command.args.join(' ')}`);
      changes.push('  Every other line in that file is left exactly as it is.');

      return {
        clientId: CODEX_ID,
        scope: input.scope,
        projectRoot: input.projectRoot,
        configPath: path,
        changes,
        entry: block,
        serverName: input.serverName,
        ...(input.scope === 'project'
          ? {
              manualStep: manualStepFor(home, input.projectRoot),
            }
          : {}),
      };
    },

    async apply(plan: ConnectPlan): Promise<ConnectReceipt> {
      const path = plan.configPath;
      if (path === null) throw new Error('This plan has no file to write.');

      // Read, back up, splice, rename. The splice replaces our own lines and nothing else,
      // so a comment someone wrote above their sandbox settings is still there afterwards.
      const config = readTomlConfig(path);
      const backupPath = backup(path);
      const merged = withTomlTable(config, tablePathOf(plan), plan.entry as string);
      writeTextAtomically(path, merged, config.bom);

      return {
        clientId: CODEX_ID,
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

      const config = readTomlConfig(path);
      const entry = serverEntry(config.document, receipt.serverName);
      if (entry?.command === undefined) {
        return { ok: false, step: 'spawn', detail: `No ${receipt.serverName} entry in ${path}.` };
      }

      // Spawned exactly as Codex will spawn it, which is the only way to learn that the
      // command in the file does not actually start.
      const check = await probe({ executable: entry.command, args: entry.args ?? [] });
      if (!check.ok) return check;

      if (receipt.scope === 'project' && projectTrust(home, receipt.projectRoot) !== 'trusted') {
        return {
          ...check,
          ok: false,
          step: 'trust',
          detail: `The server answers, but Codex only reads ${path} in a project you have trusted, and this one is not trusted yet. Run \`codex\` here once and choose to trust the folder.`,
          pendingTrust: true,
        };
      }

      // Codex's own view, asked from the project directory so the answer is the merged one it
      // would actually use. An empty list here is exactly the silent failure this guards.
      try {
        const { stdout } = await runClient(['mcp', 'list', '--json'], { cwd: receipt.projectRoot });
        if (!listsServer(stdout, receipt.serverName)) {
          return {
            ...check,
            ok: false,
            step: 'trust',
            detail: `The server answers, but Codex does not list ${receipt.serverName} yet. Restart it, or trust this project when it asks.`,
            pendingTrust: true,
          };
        }
      } catch {
        // Codex cannot be asked, which says nothing about whether the server works. The
        // protocol check above is the evidence that matters.
      }

      return check;
    },

    async remove(receipt: ConnectReceipt): Promise<void> {
      const path = receipt.configPath;
      if (path === null || !existsSync(path)) return;

      const config = readTomlConfig(path);
      const { text, removed } = withoutTomlTable(config, tablePath(receipt.serverName));
      // Only when something actually changed: rewriting the file to remove nothing would
      // reformat a configuration for no reason.
      if (!removed) return;

      backup(path);
      writeTextAtomically(path, text, config.bom);
    },
  };
}

/** The table path a plan targets, recovered from the plan rather than recomputed. */
function tablePathOf(plan: ConnectPlan): readonly string[] {
  return [SERVERS_KEY, plan.serverName];
}

/**
 * Refuses a file whose `mcp_servers` is not a table of tables.
 *
 * `mcp_servers = 3` and `[[mcp_servers]]` both parse as valid TOML and both mean the file is
 * not shaped the way this adapter understands. Splicing a table into either would produce a
 * document Codex cannot load, which is precisely the corruption to avoid.
 */
function assertServersAreTables(document: Record<string, unknown>, path: string): void {
  const servers = document[SERVERS_KEY];
  if (servers === undefined) return;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new Error(
      `${path} declares \`${SERVERS_KEY}\` as something other than a table of servers, so it will not be edited.`,
    );
  }
}

/**
 * Refuses a file that declares our server in a form the splice cannot locate.
 *
 * TOML allows `[mcp_servers]` followed by `lorepack.command = "x"`, which defines the same
 * entry with no `[mcp_servers.lorepack]` header anywhere in the text. Appending our table to
 * that file redefines a table TOML has already seen, and the result does not parse **at all**:
 * the user's entire Codex configuration stops loading, over an entry they were only trying to
 * replace. Measured, not reasoned about.
 *
 * A splice that guessed at a position instead would move the wrong lines, so the honest
 * answer is to refuse and hand over a snippet.
 */
function assertEditable(
  text: string,
  document: Record<string, unknown>,
  serverName: string,
  path: string,
): void {
  if (serverEntry(document, serverName) === undefined) return;
  if (tableSpan(text, [SERVERS_KEY, serverName]) !== undefined) return;

  throw new Error(
    `${path} declares \`${SERVERS_KEY}.${serverName}\` without a \`[${SERVERS_KEY}.${serverName}]\` table, which this adapter cannot edit without risking the rest of the file. Run \`lore connect codex --snippet\` and edit it by hand.`,
  );
}

function serverEntry(
  document: Record<string, unknown>,
  serverName: string,
): { command?: string; args?: string[]; cwd?: string } | undefined {
  const servers = document[SERVERS_KEY];
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return undefined;
  const entry = (servers as Record<string, unknown>)[serverName];
  if (typeof entry !== 'object' || entry === null) return undefined;
  return entry as { command?: string; args?: string[]; cwd?: string };
}

/** `codex mcp list --json` answers an array of objects with a `name`. */
function listsServer(stdout: string, serverName: string): boolean {
  const start = stdout.indexOf('[');
  if (start === -1) return false;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as readonly { name?: unknown }[];
    return parsed.some((server) => server.name === serverName);
  } catch {
    return false;
  }
}

/** What still has to happen by hand, stated before the write rather than after it. */
function manualStepFor(home: string, projectRoot: string): string {
  const trusted = projectTrust(home, projectRoot) === 'trusted';
  const shareable =
    'This writes `.codex/config.toml` inside the project, which is a file people commit deliberately. Anyone who checks it out gets this server entry.';
  if (trusted) return shareable;
  return `${shareable} Codex also reads it only in a project you have trusted, and this one is not trusted yet: run \`codex\` here once and choose to trust the folder.`;
}

/**
 * The copy-paste fallback, for a Codex this adapter will not edit.
 *
 * Architecture 14.8: an unsupported version degrades to a printed configuration rather than a
 * speculative edit. There is no ownership comment here on purpose, because nothing is being
 * removed later: what the user pastes is theirs.
 */
export function codexSnippet(input: ConnectInput): string {
  return `${[
    `[${SERVERS_KEY}.${input.serverName}]`,
    `command = ${tomlString(input.command.executable)}`,
    `args = [${input.command.args.map(tomlString).join(', ')}]`,
    `cwd = ${tomlString(input.projectRoot)}`,
  ].join('\n')}\n`;
}
