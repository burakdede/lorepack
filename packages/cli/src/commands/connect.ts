import {
  CLAUDE_CODE_ID,
  type ClientConnector,
  type ConnectInput,
  type ConnectScope,
  createClaudeCodeConnector,
  renderSnippetAdvice,
  renderVerifiedSnippet,
  SERVER_NAME,
  type Snippet,
} from '@lorepack/connect-clients';
import { LoreError, loadConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';

/**
 * `lore connect [client]` and `lore disconnect [client]`, the second of the two commands.
 *
 * Architecture 6.6 makes this an eleven step contract rather than a file write, and the
 * ordering is the reason: **plan, show, apply, verify**. Every step exists because skipping
 * it produces a specific, quiet failure.
 *
 * - A plan that is shown before anything changes is what makes editing someone's client
 *   configuration acceptable rather than presumptuous.
 * - A verification that spawns the server is the only way to learn that the command in the
 *   file does not actually start. Written correctly and pointing at a missing binary looks
 *   exactly like success until a person asks their agent a question and gets nothing.
 * - A trust prompt the client will still show is printed rather than left to surprise them.
 *
 * Registration is explicit (architecture 4.8). There is no dynamic discovery of connectors,
 * so `lore connect --help` lists what actually exists and a reviewer can see a new client
 * arriving in a diff.
 */

/** Every connector, named. Codex and VS Code arrive in Phase 5 with #80 and #81. */
function connectors(options: { shared: boolean }): readonly ClientConnector[] {
  return [createClaudeCodeConnector({ shared: options.shared })];
}

export function connectCommand(): CommandDefinition {
  return {
    name: 'connect',
    description: 'Configure an AI client to read this project, and verify that it works.',
    arguments: [
      { name: 'client', description: `which client (${CLAUDE_CODE_ID}, or all)`, required: false },
    ],
    flags: [
      { flags: '--dry-run', description: 'show the plan and change nothing' },
      { flags: '--yes', description: 'apply without asking' },
      { flags: '--scope <scope>', description: 'project (default) or user' },
      {
        flags: '--shared',
        description: 'write the project file that others will be asked to trust',
      },
      { flags: '--snippet', description: 'print a configuration to paste, and change nothing' },
    ],
    handler: async (args, flags, context): Promise<CommandResult> => {
      const config = loadConfig({ cwd: context.options.cwd });
      const scope = resolveScope(flags.scope);
      const chosen = select(args[0], { shared: flags.shared === true });

      const input: ConnectInput = {
        projectRoot: config.projectRoot,
        serverName: SERVER_NAME,
        // An executable plus an argument array, never a concatenated string. That is what
        // makes a project path containing a space safe on every platform (6.6 step 7).
        command: {
          executable: 'lore',
          args: ['mcp', '--project', config.projectRoot, '--ensure-current'],
        },
        scope,
      };

      // A client nobody has verified, or an explicit request for something to paste. Both
      // land here rather than failing: architecture 14.7 asks for a verified snippet, and an
      // error helps nobody who simply uses a different editor.
      const unknown = args[0] !== undefined && args[0] !== 'all' && chosen.length === 0;
      if (flags.snippet === true || unknown) {
        const snippet = await renderVerifiedSnippet(input);
        return { human: renderSnippet(snippet, args[0]), json: snippet };
      }

      const lines: string[] = [];
      const receipts: unknown[] = [];

      for (const connector of chosen) {
        const detected = await connector.detect();
        if (!detected.installed) {
          lines.push(`${connector.title}: not installed. ${detected.reason ?? ''}`.trimEnd());
          lines.push('  Run `lore connect --snippet` for a configuration to paste.');
          continue;
        }

        const plan = await connector.plan(input);
        lines.push(
          `${connector.title}${detected.version === undefined ? '' : ` ${detected.version}`}`,
        );
        for (const change of plan.changes) lines.push(`  ${change}`);

        if (flags.dryRun === true) {
          // Zero writes, which is the only promise `--dry-run` makes and the only one that
          // matters: someone runs it precisely because they do not trust this yet.
          lines.push('  (dry run, nothing was changed)');
          continue;
        }

        const receipt = await connector.apply(plan);
        receipts.push(receipt);
        if (receipt.backupPath !== undefined) lines.push(`  Backed up to ${receipt.backupPath}`);

        const check = await connector.verify(receipt);
        lines.push(check.ok ? `  Verified: ${check.detail}` : `  Not working yet: ${check.detail}`);
        if (plan.manualStep !== undefined) lines.push(`  ${plan.manualStep}`);
      }

      return { human: lines.join('\n'), json: { receipts } };
    },
  };
}

export function disconnectCommand(): CommandDefinition {
  return {
    name: 'disconnect',
    description: 'Remove the Lorepack entry from an AI client, leaving everything else.',
    arguments: [
      { name: 'client', description: `which client (${CLAUDE_CODE_ID}, or all)`, required: false },
    ],
    flags: [
      { flags: '--scope <scope>', description: 'project (default) or user' },
      { flags: '--shared', description: 'the project file rather than the local one' },
    ],
    handler: async (args, flags, context): Promise<CommandResult> => {
      const config = loadConfig({ cwd: context.options.cwd });
      const scope = resolveScope(flags.scope);
      const chosen = select(args[0], { shared: flags.shared === true });

      const lines: string[] = [];
      for (const connector of chosen) {
        const plan = await connector.plan({
          projectRoot: config.projectRoot,
          serverName: SERVER_NAME,
          command: { executable: 'lore', args: [] },
          scope,
        });

        await connector.remove({
          clientId: connector.id,
          scope,
          serverName: SERVER_NAME,
          configPath: plan.configPath,
          connectedAt: new Date().toISOString(),
        });
        // Deliberately unconditional wording: `remove` leaves anything it did not create, so
        // claiming to have removed something would sometimes be untrue.
        lines.push(
          `${connector.title}: any Lorepack entry in ${plan.configPath} has been removed.`,
        );
      }

      return { human: lines.join('\n'), json: undefined };
    },
  };
}

function select(
  name: string | undefined,
  options: { shared: boolean },
): readonly ClientConnector[] {
  const all = connectors(options);
  if (name === undefined || name === 'all') return all;

  // An unknown client is not an error. The caller renders a verified snippet for it, which
  // is the documented degradation path rather than a dead end (architecture 6.6).
  const found = all.find((connector) => connector.id === name);
  return found === undefined ? [] : [found];
}

/** The snippet, and what can honestly be said about a client nobody has verified. */
function renderSnippet(snippet: Snippet, client: string | undefined): string {
  const lines: string[] = [];
  if (client !== undefined) lines.push(`Lorepack has no verified adapter for ${client}.`, '');

  lines.push('Add this to your MCP client configuration:', '', snippet.json.trimEnd(), '');
  lines.push('Or, for a client that takes a command:', '');
  lines.push(`  ${process.platform === 'win32' ? snippet.windowsCommand : snippet.posixCommand}`);
  lines.push('');

  const check = snippet.verification;
  if (check !== undefined) {
    // Verified means the server was started, not that the JSON parses. A snippet naming a
    // command that does not run is worse than none, because it looks like it should work.
    lines.push(
      check.ok
        ? `Checked: the server started and answered. ${check.detail}`
        : `Unverified: ${check.detail}`,
    );
    lines.push('');
  }

  lines.push(...renderSnippetAdvice([CLAUDE_CODE_ID]));
  lines.push('', 'Nothing was changed.');
  return lines.join('\n');
}

/**
 * Project unless a user says otherwise, and `all` never implies user scope.
 *
 * Architecture 6.6: a user-scope entry configures every project on the machine to read one
 * project's documents, which for a private corpus is worse than merely surprising.
 */
function resolveScope(raw: unknown): ConnectScope {
  if (raw === undefined || raw === 'project') return 'project';
  if (raw === 'user') return 'user';
  throw new LoreError('LORE_E_INVALID_ARGUMENT', `Unknown scope: ${String(raw)}.`, {
    remediation: 'Use --scope project (the default) or --scope user.',
    subject: String(raw),
  });
}
