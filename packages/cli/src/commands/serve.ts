import { loadConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { DEFAULT_REVALIDATE_INTERVAL_MS } from '../services/revalidate.js';
import {
  parseInterval,
  parsePort,
  SERVE_DEFAULTS,
  startServing,
  untilInterrupted,
} from '../services/serving.js';

/**
 * `lore serve`: the read-only server for whatever build is active.
 *
 * It does not watch, fingerprint on a timer, or build. That is `lore dev`'s job, and keeping
 * them apart is what makes this one safe to leave running: a server that rebuilds on its own
 * is a server that can change what a client sees mid-conversation for reasons the client
 * cannot see.
 *
 * What it does do is re-read the active pointer on every request, so `lore build` or
 * `lore rollback` in another terminal is picked up at the next request with no restart
 * (architecture 15.2).
 *
 * The serving itself lives in `services/serving.ts`, because `lore dev` serves the same way
 * and a second implementation would be a second port policy and a second way to drain.
 */

export function serveCommand(): CommandDefinition {
  return {
    name: 'serve',
    description: 'Serve the active build over HTTP and MCP. Read-only, and never rebuilds.',
    flags: [
      {
        flags: '--port <number>',
        description: `port to listen on (default ${SERVE_DEFAULTS.port})`,
      },
      { flags: '--host <address>', description: 'address to bind (default 127.0.0.1)' },
      {
        flags: '--revalidate-interval <ms>',
        description: 'how often to recheck the sources (default 5000, 0 every request)',
      },
    ],
    handler: async (_args, flags, context): Promise<CommandResult> => {
      const config = loadConfig({ cwd: context.options.cwd });
      const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';

      const server = await startServing({
        config,
        host,
        port: parsePort(flags.port),
        warn: context.warn,
        // Rechecked on an interval with a cheap metadata prescreen inside it, so a server
        // left running all day stays honest without hashing the corpus per request (#112).
        revalidateIntervalMs:
          flags.revalidateInterval === undefined
            ? DEFAULT_REVALIDATE_INTERVAL_MS
            : parseInterval(flags.revalidateInterval),
      });

      context.write(
        [
          `Serving ${config.config.name} from build ${server.buildId.slice(0, 17)}`,
          '',
          `  REST  ${server.url}/v1`,
          `  MCP   ${server.url}/mcp`,
          `  Health ${server.url}/health`,
          '',
          'Read-only. `lore build` in another terminal is picked up on the next request.',
          'Press Ctrl-C to stop.',
          '',
        ].join('\n'),
      );

      await untilInterrupted(context.warn);
      await server.close();
      return { human: '', json: undefined };
    },
  };
}

export { SERVE_DEFAULTS };
