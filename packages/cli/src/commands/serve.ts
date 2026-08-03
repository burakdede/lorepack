import { serve } from '@hono/node-server';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { LoreError, loadConfig } from '@lorepack/core';
import { createMcpHttpHandler } from '@lorepack/mcp';
import { createApiApp, createRuntime } from '@lorepack/runtime';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { createLocalComparer } from '../services/comparer.js';
import { createRevalidator, DEFAULT_REVALIDATE_INTERVAL_MS } from '../services/revalidate.js';

/**
 * `lore serve`: the read-only server for whatever build is active.
 *
 * It does not watch, fingerprint on a timer, or build. That is `lore dev`'s job in Phase 3,
 * and keeping them apart is what makes this one safe to leave running: a server that
 * rebuilds on its own is a server that can change what a client sees mid-conversation for
 * reasons the client cannot see.
 *
 * What it does do is re-read the active pointer on every request, so `lore build` or
 * `lore rollback` in another terminal is picked up at the next request with no restart
 * (architecture 15.2).
 */

const DEFAULT_PORT = 4321;
/** How many ports to try before giving up. Enough for several servers, few enough to fail. */
const PORT_ATTEMPTS = 20;

export function serveCommand(): CommandDefinition {
  return {
    name: 'serve',
    description: 'Serve the active build over HTTP and MCP. Read-only, and never rebuilds.',
    flags: [
      { flags: '--port <number>', description: `port to listen on (default ${DEFAULT_PORT})` },
      { flags: '--host <address>', description: 'address to bind (default 127.0.0.1)' },
      {
        flags: '--revalidate-interval <ms>',
        description: 'how often to recheck the sources (default 5000, 0 every request)',
      },
    ],
    handler: async (_args, flags, context): Promise<CommandResult> => {
      const config = loadConfig({ cwd: context.options.cwd });
      const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
      const requested = parsePort(flags.port);

      // Rechecked on an interval with a cheap metadata prescreen inside it, so a server
      // left running all day stays honest without hashing the corpus per request (#112).
      const revalidator = createRevalidator({
        config,
        intervalMs:
          flags.revalidateInterval === undefined
            ? DEFAULT_REVALIDATE_INTERVAL_MS
            : parseInterval(flags.revalidateInterval),
      });
      const backend = createLocalRuntimeBackend({
        projectRoot: config.projectRoot,
        // Freshness is an annotation and never fails a read: a server that refused to
        // answer because the source tree moved would be useless (#147).
        freshness: () => revalidator.freshness(),
      });

      const active = await backend.provider.current();
      if (active === null) {
        backend.close();
        throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no build to serve.', {
          remediation: 'Run `lore build` first.',
        });
      }

      const runtime = createRuntime(backend);
      // One handler for the process, built once: it constructs a fresh server per request
      // internally, which is what the stateless model asks for, and holds the machinery
      // that would otherwise be rebuilt on every call.
      const mcp = createMcpHttpHandler(runtime, createLocalComparer(config.projectRoot));
      const app = createApiApp({
        runtime,
        currentBuild: () => backend.provider.current(),
        freshness: () => revalidator.freshness(),
        mcpHandler: (request) => mcp.fetch(request),
      });

      if (!isLoopback(host)) {
        // Architecture 15.3: binding beyond loopback is possible and never accidental.
        context.warn(
          `Warning: binding to ${host} exposes this build to your network. It is read-only, and it is still your documents.\n`,
        );
      }

      const server = await listen(app.fetch, host, requested, context.warn);
      const url = `http://${host}:${server.port}`;

      context.write(
        [
          `Serving ${config.config.name} from build ${active.buildId.slice(0, 17)}`,
          '',
          `  REST  ${url}/v1`,
          `  MCP   ${url}/mcp`,
          `  Health ${url}/health`,
          '',
          'Read-only. `lore build` in another terminal is picked up on the next request.',
          'Press Ctrl-C to stop.',
          '',
        ].join('\n'),
      );

      await untilStopped(server.close, backend.close, context.warn);
      return { human: '', json: undefined };
    },
  };
}

interface Listening {
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * Binds, stepping to the next port when one is taken.
 *
 * Architecture 6.9 asks for exactly this: an occupied port is an ordinary condition of a
 * developer machine, not a failure, so the server moves and says where it went.
 */
async function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  hostname: string,
  first: number,
  warn: (text: string) => void,
): Promise<Listening> {
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const port = first + attempt;
    try {
      const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
        const started = serve({ fetch, hostname, port }, () => resolve(started));
        started.on('error', reject);
      });
      if (attempt > 0) warn(`Port ${first} was busy, using ${port}.\n`);
      return {
        port,
        close: () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'EADDRINUSE') throw error;
    }
  }

  throw new LoreError(
    'LORE_E_INVALID_ARGUMENT',
    `No free port between ${first} and ${first + PORT_ATTEMPTS - 1}.`,
    { remediation: 'Pass a different --port, or stop whatever is using this range.' },
  );
}

/**
 * Runs until interrupted, then stops accepting, drains and releases.
 *
 * The order matters: `close()` stops new connections and waits for in-flight requests, and
 * only then are the databases released. Releasing first would let a request in flight read
 * a closed handle.
 */
async function untilStopped(
  closeServer: () => Promise<void>,
  closeBackend: () => void,
  warn: (text: string) => void,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (signal: string): void => {
      warn(`\nStopping on ${signal}. Draining requests.\n`);
      resolve();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });

  await closeServer();
  closeBackend();
}

/** Closes the MCP handler's in-flight exchanges alongside the server. */
export type McpCloser = () => Promise<void>;

/** Milliseconds, or 0 for every request. `off` belongs to `lore mcp`, which can pin. */
function parseInterval(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      `--revalidate-interval must be a number of milliseconds, got ${raw}.`,
      { remediation: 'Pass milliseconds, or 0 to recheck on every request.' },
    );
  }
  return value;
}

function parsePort(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `--port must be a port number, got ${raw}.`, {
      remediation: `Pass a number between 1 and 65535, for example --port ${DEFAULT_PORT}.`,
    });
  }
  return value;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Exported for the tests, which assert the wording rather than reproducing it. */
export const SERVE_DEFAULTS = { port: DEFAULT_PORT, attempts: PORT_ATTEMPTS } as const;
