import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import {
  count,
  LoreError,
  loadConfig,
  ProgressBus,
  ProgressRenderer,
  type SourceState,
} from '@lorepack/core';
import { createMcpServer } from '@lorepack/mcp';
import { createRuntime } from '@lorepack/runtime';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { runBuild } from '../services/build.js';
import { createLocalComparer } from '../services/comparer.js';
import { createRevalidator, DEFAULT_REVALIDATE_INTERVAL_MS } from '../services/revalidate.js';
import { readFreshness, readStatus } from '../services/status.js';

/**
 * `lore mcp`: the stdio server a coding agent launches.
 *
 * The startup sequence is architecture 14.3, and its order is the whole point. Freshness is
 * reconciled **before the first protocol byte**, so a client that launched against a dirty
 * project never sees stale context and never has to ask. Once the protocol starts, stdout
 * belongs to it: every diagnostic goes to stderr, and a stray `console.log` here would
 * corrupt a frame and give the client a parse error with no explanation.
 */

export function mcpCommand(): CommandDefinition {
  return {
    name: 'mcp',
    description: 'Serve the active build to an AI client over MCP on stdio.',
    flags: [
      {
        flags: '--ensure-current',
        description: 'rebuild first when the sources have changed (the default)',
      },
      { flags: '--allow-stale', description: 'serve the existing build even when sources changed' },
      { flags: '--active-only', description: 'skip source checks entirely, for pinned or CI use' },
      { flags: '--project <path>', description: 'the project to serve' },
      {
        flags: '--revalidate-interval <ms>',
        description:
          'how often to recheck the sources while serving (default 5000, 0 every request, off never)',
      },
    ],
    handler: async (_args, flags, context): Promise<CommandResult> => {
      const cwd = typeof flags.project === 'string' ? flags.project : context.options.cwd;
      const config = loadConfig({ cwd });

      const mode = resolveMode(flags);
      const sourceState = await reconcile({ config, mode, warn: context.warn });

      // Freshness while serving, not only at startup. An open connection is not a session
      // (2026-07-28), so a process can run for an hour and would otherwise report the state
      // it saw in its first second for all of it (#112).
      const revalidator = createRevalidator({
        config,
        intervalMs: parseInterval(flags.revalidateInterval),
        frozen: mode !== 'ensure-current',
      });
      const backend = createLocalRuntimeBackend({
        projectRoot: config.projectRoot,
        freshness:
          mode === 'ensure-current' ? () => revalidator.freshness() : async () => sourceState,
      });

      if ((await backend.provider.current()) === null) {
        backend.close();
        throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no build to serve.', {
          remediation: 'Run `lore build` first, or start the server with --ensure-current.',
        });
      }

      // A factory, not a single server, because the opening message decides the protocol
      // era and `serveStdio` pins one instance from this factory for the connection.
      //
      // Hand-wiring a `StdioServerTransport` instead, which is the shape most examples
      // show, skips that decision entirely: the connection stays in the 2025 era, and
      // `server/discover` (a MUST in 2026-07-28) is answered with `Method not found` even
      // though the handler is registered. That is #189, and it was invisible because the
      // HTTP surface reaches the same decision through `createMcpHandler`.
      const runtime = createRuntime(backend);
      const comparer = createLocalComparer(config.projectRoot);
      const factory = (): ReturnType<typeof createMcpServer> =>
        createMcpServer({ runtime, comparer });

      // The lock and the databases have to be released however the process ends, including
      // on a signal. A client that kills the server should not leave a project locked.
      //
      // Idempotent, because every one of these paths can fire: a clean shutdown closes
      // explicitly and `exit` fires afterwards. A second close used to reach a closed
      // database and end the process with a stack trace, on the way out of a session that
      // had worked perfectly.
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        backend.close();
      };
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
      process.once('exit', close);

      context.warn(
        `Serving ${config.config.name} over MCP on stdio. Sources are ${sourceState}.\n`,
      );
      const handle = serveStdio(factory, {
        onerror: (error) => context.warn(`${error.message}\n`),
      });

      // Resolves when the client goes away.
      //
      // Standard input ending is the ordinary route: a client exits, or the pipe closes.
      // It has to be handled explicitly, because without it the await never settles, Node
      // notices an empty event loop with a pending top-level await, and prints a warning
      // into the agent's log that looks like a defect in Lorepack (#183).
      //
      // `serveStdio` owns the transport and overwrites its `onclose`, so this is the one
      // observation point left, which is fine: it is the route a real client takes.
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          resolve();
        };
        process.stdin.once('end', finish);
        process.stdin.once('close', finish);
      });
      await handle.close();
      close();

      // Nothing structured on stdout: it carried protocol, and it is now finished.
      return { human: '', json: undefined };
    },
  };
}

type Mode = 'ensure-current' | 'allow-stale' | 'active-only';

/**
 * How often to recheck while serving. `off` is the startup-only behaviour, kept because a
 * pinned deployment may want it, and named rather than implied.
 */
function parseInterval(raw: unknown): number {
  if (raw === undefined) return DEFAULT_REVALIDATE_INTERVAL_MS;
  if (raw === 'off') return Number.POSITIVE_INFINITY;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      `--revalidate-interval must be milliseconds, 0, or off, got ${raw}.`,
      { remediation: 'Pass a number of milliseconds, 0 to check every request, or off.' },
    );
  }
  return value;
}

function resolveMode(flags: Record<string, unknown>): Mode {
  const stale = flags.allowStale === true;
  const activeOnly = flags.activeOnly === true;
  if (stale && activeOnly) {
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      '--allow-stale and --active-only cannot both be given.',
      { remediation: 'Pick one: --allow-stale serves a dirty project, --active-only ignores it.' },
    );
  }
  if (activeOnly) return 'active-only';
  if (stale) return 'allow-stale';
  return 'ensure-current';
}

/**
 * Reconciles the build with the sources, before any protocol output.
 *
 * The three modes are three different promises to the client:
 *
 * - `ensure-current` (the default) rebuilds a dirty project, so the first tool call reads
 *   what is on disk now. A failed rebuild exits without serving: stale context delivered
 *   confidently is worse than no context.
 * - `allow-stale` serves what exists and labels every result `dirty`, which is honest and
 *   is what a user asking for it wants.
 * - `active-only` does not look at the sources at all, for a pinned build in CI or a
 *   forensic read of an old one.
 */
async function reconcile(options: {
  config: ReturnType<typeof loadConfig>;
  mode: Mode;
  warn: (text: string) => void;
}): Promise<SourceState> {
  if (options.mode === 'active-only') return 'unknown';

  const started = Date.now();
  const status = await readStatus({ config: options.config, allowLargeProject: true }).catch(
    () => null,
  );

  // No build at all is a different situation from a stale one, and only one of the three
  // modes can do anything about it. `--ensure-current` means exactly this: make the served
  // build match the sources, and there being none yet is the strongest form of not
  // matching. The other two modes have nothing to serve and say so.
  if (status?.sourceState === 'unbuilt') {
    if (options.mode !== 'ensure-current') {
      throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no build to serve.', {
        remediation: 'Run `lore build`, or start the server with --ensure-current.',
      });
    }
    options.warn('No build yet. Building before serving.\n');
    await rebuild(options);
    return 'clean';
  }

  const freshness = await readFreshness({ config: options.config });
  const elapsed = Date.now() - started;
  if (elapsed > 250) {
    // Architecture 4.10: a check a person can notice has to say what it is doing, and the
    // only place it may say anything is stderr.
    options.warn(`Checked sources in ${elapsed} ms.\n`);
  }

  if (freshness.sourceState !== 'dirty') return freshness.sourceState;
  if (options.mode === 'allow-stale') {
    options.warn(
      'Sources have changed since this build. Serving it anyway: every result is labelled dirty.\n',
    );
    return 'dirty';
  }

  options.warn(
    `Sources have changed: ${count(
      (status?.artifacts.changed ?? 0) + (status?.artifacts.added ?? 0),
      'source',
    )}. Rebuilding before serving.\n`,
  );
  await rebuild(options);
  return 'clean';
}

/**
 * Builds, with progress on stderr and nothing at all on stdout.
 *
 * stdout is about to carry protocol frames, and a progress line in the middle of one is a
 * parse error the client cannot explain to anyone (architecture 14.3).
 */
async function rebuild(options: {
  config: ReturnType<typeof loadConfig>;
  warn: (text: string) => void;
}): Promise<void> {
  const progress = new ProgressBus();
  const renderer = new ProgressRenderer({ write: options.warn, isTty: false });
  progress.subscribe((event) => renderer.handle(event));

  try {
    await runBuild({ config: options.config, progress, allowLargeProject: true });
  } catch (cause) {
    // A failed build leaves the previous pointer where it was and serves nothing. Stale
    // context delivered confidently is worse than an error a person can act on (6.9).
    throw new LoreError(
      'LORE_E_STALE_SOURCES',
      'The project could not be built, so nothing was served.',
      {
        remediation:
          'Run `lore build` to see the failure, or start with --allow-stale to serve the existing build.',
        cause,
      },
    );
  }
}
