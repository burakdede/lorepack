import { isAbsolute, resolve } from 'node:path';
import { assertFts5Available } from '@lorepack/backend-local';
import { count, LoreError, loadConfig } from '@lorepack/core';
import type { CommandContext } from '../framework/context.js';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { type BuildResult, runBuild } from '../services/build.js';
import {
  assertNoLiveSession,
  DEV_PORT,
  removeReceipt,
  writeReceipt,
} from '../services/dev-session.js';
import { enclosingProject, type InitResult, planInit, runInit } from '../services/init.js';
import { parsePort, startServing, untilInterrupted } from '../services/serving.js';
import { startWatching } from '../services/watch.js';

/**
 * `lore dev [path]`: a folder becomes a running, connected context runtime, asking nothing.
 *
 * This is the headline command (architecture 2.2, 6.2), and its whole design is an ordering
 * decision: **validate, then inspect, then mutate**. Section 6.2 lists the seven steps in
 * that order for a reason. A run that discovers on step five that this Node build has no
 * FTS5 has already written files into someone's directory to learn it.
 *
 * So the order below is load-bearing rather than incidental:
 *
 * 1. capability validation, which touches nothing;
 * 2. inspection, which reads the directory and writes nothing;
 * 3. atomic init, which writes and says exactly what it wrote;
 * 4. build and activate;
 * 5. serve;
 * 6. print how to connect.
 *
 * It supervises rather than reimplements. Init comes from the same module `lore init` uses,
 * the build from the same `runBuild` that `lore build` calls, and the server from
 * `services/serving.ts`, which is where `lore serve` gets it too. A second implementation of
 * any of them would be a second behaviour for a user to discover.
 */

export function devCommand(): CommandDefinition {
  return {
    name: 'dev',
    description: 'Turn a folder into a running context runtime. Builds, serves, and connects.',
    arguments: [{ name: 'path', description: 'project directory (default: .)', required: false }],
    flags: [
      { flags: '--port <number>', description: `port to listen on (default ${DEV_PORT})` },
      { flags: '--host <address>', description: 'address to bind (default 127.0.0.1)' },
      {
        flags: '--yes',
        description: 'accept defaults without asking (the default path asks nothing)',
      },
      { flags: '--allow-large-project', description: 'continue past the supported file count' },
    ],
    handler: async (args, flags, context): Promise<CommandResult> => {
      const directory = resolveDirectory(args[0], context);

      // Step 1. Before anything is written. Node itself is checked in the entry point, which
      // is earlier still; this is the capability that a supported Node can nonetheless lack,
      // because a build linked against a shared SQLite may omit FTS5.
      assertFts5Available();

      // Steps 2 and 3. `planInit` reads and writes nothing, so a directory that cannot be
      // initialized is refused before it is touched.
      const initialized = autoInit(directory, context);

      const config = loadConfig({ cwd: directory });

      // Before building or binding anything: two supervisors on one project would both
      // watch, both rebuild, and take turns losing the build lock. A receipt whose process
      // is gone is cleared here rather than treated as an obstacle.
      assertNoLiveSession(config);

      // Step 4. The same builder `lore build` runs, with its stage table on the same bus, so
      // a slow parse shows a moving count here exactly as it does there (architecture 6.4).
      const built = await runBuild({
        config,
        progress: context.progress,
        activate: true,
        allowLargeProject: flags.allowLargeProject === true,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });

      // Step 5. Watching starts before serving, so the server can be handed the watcher's
      // answer about freshness instead of polling for it. Architecture 12.11 step 3 runs
      // inside this: a reconciliation scan once the watcher is ready, closing the race
      // between the build above and the first event below.
      const watching = startWatching({
        config,
        warn: context.warn,
        rebuild: async (signal) => {
          const result = await runBuild({
            config,
            progress: context.progress,
            activate: true,
            signal,
          });
          return { created: result.created };
        },
      });

      const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
      const server = await startServing({
        config,
        host,
        // Architecture 15.3 fixes the preferred dev port, which is not the one `lore serve`
        // uses: a dev session and a read-only server are different things and a developer
        // may want both at once.
        port: flags.port === undefined ? DEV_PORT : parsePort(flags.port),
        warn: context.warn,
        // The hook #112 named. A supervisor that is watching the filesystem already knows
        // whether the sources moved, so the server stops paying for an interval scan.
        freshness: () => watching.freshness(),
      });

      // Written once the port is known and the build is activated, so it never advertises a
      // session that does not exist yet.
      writeReceipt(config, {
        port: server.port,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        buildId: server.buildId,
        host,
      });

      // Step 6.
      context.write(
        `${render({ initialized, built, url: server.url, projectRoot: config.projectRoot, name: config.config.name })}\n`,
      );

      await untilInterrupted(context.warn);
      await shutdown(config, watching, server, context.warn);
      return { human: '', json: undefined };
    },
  };
}

/** How long a drain may take before the process stops waiting for it. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * The documented stop sequence, in order, with a bound on the whole thing.
 *
 * The order is the correctness argument. The watcher goes first so a rebuild in flight is
 * cancelled and its candidate discarded before anything else moves: `runBuild` removes its
 * own incomplete candidate, so activation never sees it and the build that was active
 * stays active (architecture 6.9). The server drains next, finishing requests already in
 * flight rather than cutting them off. Only then are the databases released, because a
 * request still running would otherwise reach a closed handle.
 *
 * The receipt is removed last and unconditionally. A session that is stopping has already
 * stopped being useful to anyone reading it, and leaving one behind makes the next
 * `lore dev` refuse to start for a process that no longer exists.
 *
 * The timeout exists because a wedged request must not be able to hold the process open
 * forever. Section 15.3's contract is that Ctrl-C ends the session; it does not promise to
 * wait indefinitely for a socket that will never close.
 */
async function shutdown(
  config: ReturnType<typeof loadConfig>,
  watching: { close: () => Promise<void> },
  server: { close: () => Promise<void> },
  warn: (text: string) => void,
): Promise<void> {
  const bounded = async (): Promise<void> => {
    await watching.close();
    await server.close();
  };

  try {
    await Promise.race([
      bounded(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), SHUTDOWN_TIMEOUT_MS),
      ),
    ]);
  } catch {
    warn(`Shutdown took longer than ${SHUTDOWN_TIMEOUT_MS} ms. Exiting anyway.\n`);
  } finally {
    removeReceipt(config);
  }
}

/**
 * Writes the configuration a project needs, only when it does not have one.
 *
 * Returns null when the project was already configured, which is the re-run path: section
 * 6.2 promises a second `lore dev` skips init and rebuilds only what changed, and the build
 * step below is already incremental, so there is nothing else to do about it.
 */
function autoInit(directory: string, context: CommandContext): InitResult | null {
  const planned = planInit({ directory, force: false });
  if (planned.alreadyInitialized) return null;

  // Refused for the same reason `lore init` refuses it: a project inside a project produces
  // two builds over overlapping sources, and neither is wrong in a way anyone can see.
  const enclosing = enclosingProject(directory);
  if (enclosing !== null) {
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      `${directory} is already inside a Lorepack project rooted at ${enclosing}.`,
      {
        remediation:
          'Nested projects are not supported. Run `lore dev` in the existing project instead.',
      },
    );
  }

  const result = runInit({ directory, force: false });
  if (result.written.length > 0) {
    // Section 6.2 step 4 makes this an answer, not a diagnostic: someone pointed a command
    // at their directory and is owed a plain list of what appeared in it. So stdout, above
    // the stage table, in the order it happened.
    context.write(`Created:\n${result.written.map((file) => `  + ${file}`).join('\n')}\n\n`);
  }
  return result;
}

interface Rendered {
  readonly initialized: InitResult | null;
  readonly built: BuildResult;
  readonly url: string;
  readonly projectRoot: string;
  readonly name: string;
}

/**
 * The first-run block of architecture 6.4, containing every line whose subject exists.
 *
 * One line from the specification's example is still deliberately absent: **Studio** is
 * Phase 4 (#64), so there is no asset to serve and no URL to print. Printing it would be the
 * CLI advertising something that does not exist, which is invariant 6 and what
 * `scripts/check-command-set.mjs` fails the build over.
 *
 * The `Connect now` list arrived with #58 and #59 and names only `claude-code`, because that
 * is the only connector that exists. Codex and VS Code are Phase 5 (#80, #81) and each adds
 * its own line. #53 carries the amendment recording all of this.
 */
function render(rendered: Rendered): string {
  const { built } = rendered;
  const lines = ['', `Build           ${built.buildId.slice(0, 17)}`];

  lines.push(
    built.reusedArtifacts === 0
      ? `Reused          0 artifacts (first build)`
      : `Reused          ${count(built.reusedArtifacts, 'artifact')}`,
  );
  if (built.warnings > 0) {
    lines.push(
      `Warnings        ${count(built.warnings, 'warning')}; run \`lore inspect warnings\``,
    );
  }

  lines.push(`HTTP            ${rendered.url}/v1`);
  lines.push(`MCP HTTP        ${rendered.url}/mcp`);
  // Quoted, because a project path with a space in it is ordinary on every platform and the
  // line is meant to be pasted (#61 owns the general version of this).
  lines.push(`MCP stdio       lore mcp --project "${rendered.projectRoot}"`);
  lines.push('');
  lines.push('Connect now:');
  lines.push('  lore connect claude-code');
  lines.push('');
  lines.push('Watching for changes. Press Ctrl-C to stop.');
  return lines.join('\n');
}

function resolveDirectory(argument: string | undefined, context: CommandContext): string {
  if (argument === undefined) return context.options.cwd;
  return isAbsolute(argument) ? resolve(argument) : resolve(context.options.cwd, argument);
}
