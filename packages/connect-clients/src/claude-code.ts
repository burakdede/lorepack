import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type ConfigLocation, resolveConfigFile, writeOptionsFor } from './config-file.js';
import {
  backup,
  type ContainerPath,
  isOwned,
  markOwned,
  ownerOf,
  readJsonConfig,
  serversAt,
  withoutServerEntry,
  withServerEntry,
  writeJsonAtomically,
} from './json-config.js';
import type {
  ClientConnector,
  ClientDetection,
  ClientStatus,
  ConnectInput,
  ConnectionCheck,
  ConnectPlan,
  ConnectReceipt,
  RemoveOutcome,
} from './port.js';
import { type VerifyOptions, verifyStdioServer } from './verify.js';

/**
 * Claude Code, the first supported client and the one Milestone 1 names.
 *
 * ## Scope, which is the part that is easy to get wrong
 *
 * Architecture 6.6 maps Lorepack's workspace scope to Claude Code's `local` scope for the
 * current project, and the default is never global. A connector that quietly writes a user
 * scope entry configures every project on the machine to read one project's documents, which
 * is both surprising and, for a private corpus, worse than surprising.
 *
 * Claude Code's `local` scope is **not** a file in the project. It is
 * `projects[<absolute project path>].mcpServers` inside `.claude.json`, the client's own state
 * file in `$CLAUDE_CONFIG_DIR` or the home directory. `.claude/settings.local.json` carries
 * permissions and approvals and is never read for servers, which is what Lorepack wrote
 * before #575: a correct-looking entry the client never saw. Measured with Claude Code
 * 2.1.296 by running `claude mcp add --scope local` against a temporary `CLAUDE_CONFIG_DIR`,
 * which reported `File modified: $CLAUDE_CONFIG_DIR/.claude.json [project: <path>]`, and keyed
 * the entry by the project's real path even when run from a symlinked directory.
 *
 * `--shared` opts into the project `.mcp.json`, which is checked into the repository and
 * which the client asks each person to trust. That prompt is not a failure and must not be
 * reported as one: it is the client behaving correctly about a file that arrived from
 * version control.
 *
 * ## Why the file and not the CLI
 *
 * Architecture 6.6 step 5 prefers the client's own CLI when it can express the chosen scope
 * safely. `claude mcp add` can, and it is used for detection and status. It is deliberately
 * **not** used for the write: it gives no way to attach the ownership marker that makes
 * `disconnect` able to remove exactly our entry and nothing else, and a connector that
 * cannot undo itself precisely is one that eventually deletes something it did not create.
 */

const execute = promisify(execFile);

export const CLAUDE_CODE_ID = 'claude-code';
/** The entry name, which `disconnect` and the ownership check both key on. */
export const SERVER_NAME = 'lorepack';

/** Where Lorepack wrote the local scope before #575, and now only ever removes from. */
const LEGACY_LOCAL_FILE = ['.claude', 'settings.local.json'] as const;

/**
 * The directory holding `.claude.json`: `CLAUDE_CONFIG_DIR` when it is set, else the home
 * directory. Measured on 2.1.296: with the variable set, both local and user scope write
 * `$CLAUDE_CONFIG_DIR/.claude.json`, and `~/.claude.json` is not touched.
 */
export function claudeConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  return configured === undefined || configured === '' ? home : configured;
}

/**
 * The key Claude Code files a project under in `projects`.
 *
 * The real path, because that is what the client records: a project opened through a
 * symlink, or under macOS's `/tmp` (really `/private/tmp`), is keyed by where it actually
 * is. Forward slashes on Windows, because the client normalises its keys that way; this
 * half is from the client's behaviour as documented by its maintainers, not measured here.
 */
export function claudeProjectKey(projectRoot: string): string {
  let real = projectRoot;
  try {
    real = realpathSync(projectRoot);
  } catch {
    // A project that does not exist yet has no other name to be known by.
  }
  return process.platform === 'win32' ? real.replace(/\\/g, '/') : real;
}

interface Target {
  readonly path: string;
  readonly location: ConfigLocation;
  /** Where in that file the servers live. */
  readonly container: ContainerPath;
}

export interface ClaudeCodeOptions {
  /** Writes the project `.mcp.json`, which the client asks each person to trust. */
  readonly shared?: boolean;
  /** Overridden in tests, so detection does not depend on the developer's machine. */
  readonly runClient?: (
    args: readonly string[],
    options?: { readonly cwd?: string },
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Where `.claude.json` lives. Defaults to `claudeConfigDirectory()`. */
  readonly configDirectory?: string;
  /** How to find out whether the configured server answers. Injected for the same reason. */
  readonly probe?: (options: VerifyOptions) => Promise<ConnectionCheck>;
}

export function createClaudeCodeConnector(options: ClaudeCodeOptions = {}): ClientConnector {
  const shared = options.shared === true;
  const configDirectory = options.configDirectory ?? claudeConfigDirectory();
  const probe = options.probe ?? verifyStdioServer;
  const runClient =
    options.runClient ??
    (async (args: readonly string[], runOptions: { readonly cwd?: string } = {}) => {
      const { stdout, stderr } = await execute('claude', [...args], {
        timeout: 20_000,
        ...(runOptions.cwd === undefined ? {} : { cwd: runOptions.cwd }),
      });
      return { stdout, stderr };
    });

  /** Where each scope stores its servers, per the documented configuration surface. */
  const targetFor = (projectRoot: string, scope: ConnectInput['scope']): Target => {
    if (shared) {
      return {
        path: join(projectRoot, '.mcp.json'),
        location: { owner: 'project', projectRoot },
        container: 'mcpServers',
      };
    }
    const path = join(configDirectory, '.claude.json');
    if (scope === 'user') return { path, location: { owner: 'user' }, container: 'mcpServers' };
    return {
      path,
      location: { owner: 'user' },
      container: ['projects', claudeProjectKey(projectRoot), 'mcpServers'],
    };
  };

  /** The file actually read and written, refusing a link out of the project (#574). */
  const resolved = (target: Target, path: string = target.path): string =>
    resolveConfigFile(path, target.location);

  /** The entry an earlier Lorepack wrote where Claude Code never looked, if there is one. */
  const legacyEntryFor = (
    projectRoot: string,
    scope: ConnectInput['scope'],
    serverName: string,
  ): string | undefined => {
    if (shared || scope !== 'project') return undefined;
    try {
      const path = resolveConfigFile(join(projectRoot, ...LEGACY_LOCAL_FILE), {
        owner: 'project',
        projectRoot,
      });
      if (!existsSync(path)) return undefined;
      const entry = serversAt(readJsonConfig(path), 'mcpServers')?.[serverName];
      return isOwned(entry, projectRoot) ? path : undefined;
    } catch {
      // A settings file that is a link or does not parse is one this cleanup has no business
      // editing, and it is not what connects the client, so it must not block connecting.
      return undefined;
    }
  };

  /**
   * Takes the stale entry out of `.claude/settings.local.json`, leaving every other setting.
   *
   * Removed rather than left, because a person reading that file would reasonably believe it
   * is what connects their client. An emptied `mcpServers` is dropped too, since Lorepack is
   * the only thing that ever put one there.
   */
  const removeLegacyEntry = (
    projectRoot: string,
    scope: ConnectInput['scope'],
    serverName: string,
  ): boolean => {
    const path = legacyEntryFor(projectRoot, scope, serverName);
    if (path === undefined) return false;
    const { document } = withoutServerEntry(
      readJsonConfig(path),
      'mcpServers',
      serverName,
      projectRoot,
    );
    const servers = serversAt(document, 'mcpServers');
    const tidied =
      servers !== undefined && Object.keys(servers).length === 0
        ? Object.fromEntries(Object.entries(document).filter(([key]) => key !== 'mcpServers'))
        : document;
    backup(path);
    writeJsonAtomically(path, tidied);
    return true;
  };

  return {
    id: CLAUDE_CODE_ID,
    title: 'Claude Code',

    async detect(): Promise<ClientDetection> {
      try {
        const { stdout } = await runClient(['--version']);
        const version = stdout.trim().split('\n')[0] ?? '';
        return {
          installed: true,
          version,
          // Every version documented so far uses the same configuration surface, so the
          // adapter supports what it can see. An unrecognized shape is caught at plan time
          // by refusing to merge into a file it cannot parse, rather than guessed at here.
          supported: true,
        };
      } catch (error) {
        return {
          installed: false,
          supported: false,
          reason: `The \`claude\` command was not found: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },

    async status(input: ConnectInput): Promise<ClientStatus> {
      const detected = await this.detect();
      const target = targetFor(input.projectRoot, input.scope);
      const path = resolved(target);

      // Reads the file and nothing else. A status check that spawned the server to be sure
      // would make opening a diagnostics page a side effect.
      const document = existsSync(path) ? readJsonConfig(path) : {};
      const entry = serversAt(document, target.container)?.[input.serverName];

      return {
        ...detected,
        configPath: path,
        configured: entry !== undefined,
        ownedByLorepack: entry !== undefined && isOwned(entry, input.projectRoot),
      };
    },

    async plan(input: ConnectInput): Promise<ConnectPlan> {
      const target = targetFor(input.projectRoot, input.scope);
      const path = resolved(target);
      const entry = markOwned(
        {
          type: 'stdio',
          command: input.command.executable,
          args: [...input.command.args],
        },
        input.projectRoot,
      );

      const existing = existsSync(path) ? readJsonConfig(path) : {};
      const already = serversAt(existing, target.container)?.[input.serverName];
      const where =
        typeof target.container === 'string'
          ? path
          : `${path}, for the project ${claudeProjectKey(input.projectRoot)}`;

      const changes: string[] = [];
      if (already === undefined) {
        changes.push(`Add an MCP server named ${input.serverName} to ${where}`);
      } else if (isOwned(already, input.projectRoot)) {
        // Idempotent: re-running is how someone fixes a stale path, and it should read as a
        // routine update rather than as a conflict.
        changes.push(`Update the existing Lorepack server in ${where}`);
      } else {
        changes.push(
          `Replace a server named ${input.serverName} in ${where} that Lorepack did not create`,
        );
      }
      changes.push(`  ${input.command.executable} ${input.command.args.join(' ')}`);

      const legacy = legacyEntryFor(input.projectRoot, input.scope, input.serverName);
      if (legacy !== undefined) {
        changes.push(
          `Remove the Lorepack entry an earlier version wrote to ${legacy}, which Claude Code does not read servers from`,
        );
      }

      return {
        clientId: CLAUDE_CODE_ID,
        scope: input.scope,
        projectRoot: input.projectRoot,
        configPath: path,
        changes,
        entry,
        serverName: input.serverName,
        ...(shared
          ? {
              manualStep:
                'This writes the project `.mcp.json`, which is checked in. Claude Code asks each person to approve it the first time they open the project.',
            }
          : {}),
      };
    },

    async apply(plan: ConnectPlan): Promise<ConnectReceipt> {
      if (plan.configPath === null) throw new Error('This plan has no file to write.');
      // Resolved again: the plan was shown to a person, and the file may have changed since.
      const target = targetFor(plan.projectRoot, plan.scope);
      const path = resolved(target, plan.configPath);

      // Read, back up, merge, rename. Never replace: the file holds servers a person
      // configured by hand, and losing one is discovered much later (architecture 24.8).
      const document = readJsonConfig(path);
      const backupPath = backup(path);
      const merged = withServerEntry(
        document,
        target.container,
        plan.serverName,
        plan.entry as Record<string, unknown>,
      );
      writeJsonAtomically(path, merged, writeOptionsFor(target.location));
      removeLegacyEntry(plan.projectRoot, plan.scope, plan.serverName);

      return {
        clientId: CLAUDE_CODE_ID,
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

      const document = readJsonConfig(path);
      const container = targetFor(receipt.projectRoot, receipt.scope).container;
      const entry = serversAt(document, container)?.[receipt.serverName] as
        | { command?: string; args?: string[] }
        | undefined;

      if (entry?.command === undefined) {
        return { ok: false, step: 'spawn', detail: `No ${receipt.serverName} entry in ${path}.` };
      }

      // The server is spawned exactly as the client will spawn it, which is the only way to
      // find out that the command in the file does not actually start.
      const check = await probe({
        executable: entry.command,
        args: entry.args ?? [],
      });
      if (!check.ok) return check;

      // The client's own view, when it will give one. A server that is registered but not
      // yet trusted is its own state, not a failure (#58 reality check).
      try {
        // From the project directory: a local-scope server is listed only there.
        const { stdout } = await runClient(['mcp', 'list'], { cwd: receipt.projectRoot });
        const listed = stdout.includes(receipt.serverName);
        if (!listed) {
          return {
            ...check,
            ok: false,
            step: 'trust',
            detail: shared
              ? `The server answers, but Claude Code does not list ${receipt.serverName} yet. Approve the project's .mcp.json when Claude Code asks, then restart it.`
              : `The server answers, but \`claude mcp list\` in ${receipt.projectRoot} does not show ${receipt.serverName}. Check that Claude Code reads ${path}.`,
            pendingTrust: true,
          };
        }
      } catch {
        // The client cannot be asked, which says nothing about whether the server works.
        // The protocol check above is the evidence that matters.
      }

      return check;
    },

    async remove(receipt: ConnectReceipt): Promise<RemoveOutcome> {
      if (receipt.configPath === null) return { removed: false };
      // An entry an earlier version left where the client never read it goes too, so
      // `disconnect` after an upgrade leaves nothing of ours behind.
      const legacy = removeLegacyEntry(receipt.projectRoot, receipt.scope, receipt.serverName);

      const target = targetFor(receipt.projectRoot, receipt.scope);
      const path = resolved(target, receipt.configPath);
      if (!existsSync(path)) return { removed: legacy };

      const document = readJsonConfig(path);
      const { document: after, removed } = withoutServerEntry(
        document,
        target.container,
        receipt.serverName,
        // Scoped to this project wherever the file is shared between projects, so one
        // project's disconnect never takes another's entry.
        receipt.projectRoot,
      );
      // Only when something actually changed: rewriting the file to remove nothing would
      // reformat a user's configuration for no reason.
      if (!removed) {
        const ownedBy = ownerOf(serversAt(document, target.container)?.[receipt.serverName]);
        return ownedBy === undefined ? { removed: legacy } : { removed: legacy, ownedBy };
      }

      backup(path);
      writeJsonAtomically(path, after, writeOptionsFor(target.location));
      return { removed: true };
    },
  };
}

/**
 * The copy-paste fallback, for a client version this adapter will not edit.
 *
 * Architecture 14.8: an unsupported version degrades to a printed configuration rather than
 * a speculative edit. Guessing at an unknown shape is how a working configuration becomes a
 * broken one, and a snippet costs the user a paste.
 */
export function claudeCodeSnippet(input: ConnectInput): string {
  return JSON.stringify(
    {
      mcpServers: {
        [input.serverName]: {
          type: 'stdio',
          command: input.command.executable,
          args: [...input.command.args],
        },
      },
    },
    null,
    2,
  );
}
