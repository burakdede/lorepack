import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  backup,
  isOwned,
  markOwned,
  readJsonConfig,
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
} from './port.js';
import { verifyStdioServer } from './verify.js';

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

/** Where each scope stores its servers, per the documented configuration surface. */
function configPathFor(projectRoot: string, scope: ConnectInput['scope'], shared: boolean): string {
  if (shared) return join(projectRoot, '.mcp.json');
  if (scope === 'user') return join(homedir(), '.claude.json');
  return join(projectRoot, '.claude', 'settings.local.json');
}

export interface ClaudeCodeOptions {
  /** Writes the project `.mcp.json`, which the client asks each person to trust. */
  readonly shared?: boolean;
  /** Overridden in tests, so detection does not depend on the developer's machine. */
  readonly runClient?: (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  readonly home?: string;
}

export function createClaudeCodeConnector(options: ClaudeCodeOptions = {}): ClientConnector {
  const shared = options.shared === true;
  const runClient =
    options.runClient ??
    (async (args: readonly string[]) => {
      const { stdout, stderr } = await execute('claude', [...args], { timeout: 20_000 });
      return { stdout, stderr };
    });

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
      const path = configPathFor(input.projectRoot, input.scope, shared);

      // Reads the file and nothing else. A status check that spawned the server to be sure
      // would make opening a diagnostics page a side effect.
      const document = existsSync(path) ? readJsonConfig(path) : {};
      const entry = ((document.mcpServers ?? {}) as Record<string, unknown>)[input.serverName];

      return {
        ...detected,
        configPath: path,
        configured: entry !== undefined,
        ownedByLorepack: entry !== undefined && isOwned(entry, input.projectRoot),
      };
    },

    async plan(input: ConnectInput): Promise<ConnectPlan> {
      const path = configPathFor(input.projectRoot, input.scope, shared);
      const entry = markOwned(
        {
          type: 'stdio',
          command: input.command.executable,
          args: [...input.command.args],
        },
        input.projectRoot,
      );

      const existing = existsSync(path) ? readJsonConfig(path) : {};
      const container = (existing.mcpServers ?? {}) as Record<string, unknown>;
      const already = container[input.serverName];

      const changes: string[] = [];
      if (already === undefined) {
        changes.push(`Add an MCP server named ${input.serverName} to ${path}`);
      } else if (isOwned(already, input.projectRoot)) {
        // Idempotent: re-running is how someone fixes a stale path, and it should read as a
        // routine update rather than as a conflict.
        changes.push(`Update the existing Lorepack server in ${path}`);
      } else {
        changes.push(
          `Replace a server named ${input.serverName} in ${path} that Lorepack did not create`,
        );
      }
      changes.push(`  ${input.command.executable} ${input.command.args.join(' ')}`);

      return {
        clientId: CLAUDE_CODE_ID,
        scope: input.scope,
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
      const path = plan.configPath;
      if (path === null) throw new Error('This plan has no file to write.');

      // Read, back up, merge, rename. Never replace: the file holds servers a person
      // configured by hand, and losing one is discovered much later (architecture 24.8).
      const document = readJsonConfig(path);
      const backupPath = backup(path);
      const merged = withServerEntry(
        document,
        'mcpServers',
        plan.serverName,
        plan.entry as Record<string, unknown>,
      );
      writeJsonAtomically(path, merged);

      return {
        clientId: CLAUDE_CODE_ID,
        scope: plan.scope,
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
      const entry = ((document.mcpServers ?? {}) as Record<string, unknown>)[receipt.serverName] as
        | { command?: string; args?: string[] }
        | undefined;

      if (entry?.command === undefined) {
        return { ok: false, step: 'spawn', detail: `No ${receipt.serverName} entry in ${path}.` };
      }

      // The server is spawned exactly as the client will spawn it, which is the only way to
      // find out that the command in the file does not actually start.
      const check = await verifyStdioServer({
        executable: entry.command,
        args: entry.args ?? [],
      });
      if (!check.ok) return check;

      // The client's own view, when it will give one. A server that is registered but not
      // yet trusted is its own state, not a failure (#58 reality check).
      try {
        const { stdout } = await runClient(['mcp', 'list']);
        const listed = stdout.includes(receipt.serverName);
        if (!listed) {
          return {
            ...check,
            ok: false,
            step: 'trust',
            detail: `The server answers, but Claude Code does not list ${receipt.serverName} yet. Restart it, or approve the project when prompted.`,
            pendingTrust: true,
          };
        }
      } catch {
        // The client cannot be asked, which says nothing about whether the server works.
        // The protocol check above is the evidence that matters.
      }

      return check;
    },

    async remove(receipt: ConnectReceipt): Promise<void> {
      const path = receipt.configPath;
      if (path === null || !existsSync(path)) return;

      const document = readJsonConfig(path);
      const { document: after, removed } = withoutServerEntry(
        document,
        'mcpServers',
        receipt.serverName,
      );
      // Only when something actually changed: rewriting the file to remove nothing would
      // reformat a user's configuration for no reason.
      if (!removed) return;

      backup(path);
      writeJsonAtomically(path, after);
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
