import { serve } from '@hono/node-server';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { type BuildId, type LoadedConfig, LoreError } from '@lorepack/core';
import { createMcpHttpHandler } from '@lorepack/mcp';
import { createApiApp, createRuntime } from '@lorepack/runtime';
import { createLocalComparer } from './comparer.js';
import { renderBundleMarkdown } from './export.js';
import { packBuild } from './packing.js';
import { createRevalidator, DEFAULT_REVALIDATE_INTERVAL_MS } from './revalidate.js';
import { createStudioAssets, studioIsBuilt } from './studio-assets.js';
import { createPlanEndpoint, createWarningsEndpoint } from './studio-endpoints.js';
import {
  createActivateEndpoint,
  createBuildsEndpoint,
  createRollbackEndpoint,
} from './studio-mutations.js';

/**
 * Serving an active build over HTTP and MCP, in one place, for the two commands that do it.
 *
 * `lore serve` and `lore dev` differ in what they are willing to do to a project: one never
 * builds, the other builds and watches. They do not differ in how a build is served, and the
 * Phase 3 audit on #4 is explicit that `lore dev` should supervise the existing server rather
 * than grow a second one. Two servers would mean two port policies, two binding warnings and
 * two ways to drain, and the difference between them would be discovered by a user.
 *
 * The freshness revalidator is injectable for the same reason. `lore serve` has no better
 * information than an interval and a metadata prescreen, but a supervisor that is already
 * watching the filesystem does, and supplying it is an injection rather than a rewrite.
 */

const DEFAULT_PORT = 4321;
/** How many ports to try before giving up. Enough for several servers, few enough to fail. */
const PORT_ATTEMPTS = 20;

/** Exported for the tests, which assert the wording rather than reproducing it. */
export const SERVE_DEFAULTS = { port: DEFAULT_PORT, attempts: PORT_ATTEMPTS } as const;

export interface ServingOptions {
  readonly config: LoadedConfig;
  readonly host: string;
  readonly port: number;
  readonly warn: (text: string) => void;
  /**
   * How the server decides whether the sources have moved on.
   *
   * Omitted, it polls with a metadata prescreen on `revalidateIntervalMs`. `lore dev` passes
   * its watcher's answer instead, which is the hook #112 named and the Phase 3 audit expects
   * #53 and #55 to use.
   */
  readonly freshness?: () => Promise<import('@lorepack/core').SourceState>;
  readonly revalidateIntervalMs?: number;
  /**
   * Serve Studio at the root.
   *
   * `lore dev` does; `lore serve` does not, because Studio can activate and roll back and
   * `lore serve` promises to be read-only and never to rebuild. Two commands with different
   * promises should not quietly offer the same surface.
   */
  readonly studio?: boolean;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly buildId: BuildId;
  /** Whether Studio's assets were found and mounted, so the caller knows what to print. */
  readonly studio: boolean;
  /** Drains in-flight requests, then releases the databases. Idempotent. */
  readonly close: () => Promise<void>;
}

export async function startServing(options: ServingOptions): Promise<RunningServer> {
  const revalidator = createRevalidator({
    config: options.config,
    intervalMs: options.revalidateIntervalMs ?? DEFAULT_REVALIDATE_INTERVAL_MS,
  });
  const freshness = options.freshness ?? (() => revalidator.freshness());

  const backend = createLocalRuntimeBackend({
    projectRoot: options.config.projectRoot,
    // Freshness is an annotation and never fails a read: a server that refused to answer
    // because the source tree moved would be useless (#147).
    freshness,
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
  // internally, which is what the stateless model asks for, and holds the machinery that
  // would otherwise be rebuilt on every call.
  const comparer = createLocalComparer(options.config.projectRoot);
  const mcp = createMcpHttpHandler(runtime, comparer);
  // Absent when the package was installed without built assets, which is a broken install
  // rather than a mode: saying nothing about Studio is better than printing a URL that 404s.
  const serveStudio = options.studio === true && studioIsBuilt();
  const app = createApiApp({
    runtime,
    currentBuild: () => backend.provider.current(),
    freshness,
    mcpHandler: (request) => mcp.fetch(request),
    // Reads of the **active build**, so any server can answer them: they change nothing and
    // they touch no source file. `lore serve` offering them is the same promise it already
    // makes about `/v1/search`.
    exportBundle: async (request) => {
      const bundle = await runtime.contextForTask(
        request as Parameters<typeof runtime.contextForTask>[0],
      );
      // The same renderer `lore export` uses, so "copy as export" is byte-identical rather
      // than merely similar. A parity test asserts it.
      return renderBundleMarkdown(bundle, {
        projectName: options.config.config.name,
        moreCommand: `lore export --task ${JSON.stringify(bundle.task)} --profile deep`,
        sourceState: bundle.sourceState,
      });
    },
    sources: async () => {
      const handle = await backend.provider.acquire();
      try {
        const scope = await backend.open(handle);
        return { buildId: handle.buildId, artifacts: await scope.catalog.artifacts() };
      } finally {
        handle.release();
      }
    },
    warnings: createWarningsEndpoint(async () => {
      // Acquired and released like any other read, so a warnings request cannot pin a build
      // open after it stops being active.
      const handle = await backend.provider.acquire();
      try {
        const scope = await backend.open(handle);
        const manifest = await scope.catalog.manifest();
        return { buildId: manifest.buildId, warnings: manifest.warnings };
      } finally {
        handle.release();
      }
    }),
    ...(serveStudio
      ? {
          assets: createStudioAssets(),
          allowLoopbackOrigin: true,
          // The one Studio read that is **not** a read of the build: planning walks the
          // source tree. `lore serve` promises never to rebuild and has no business reading
          // sources, so this belongs to `lore dev` alone.
          plan: createPlanEndpoint(options.config),
          // The only writes in this API, and they exist only here. `lore serve` promises to
          // be read-only, so it passes no actions and simply does not have these routes.
          localActions: {
            builds: createBuildsEndpoint(options.config),
            diff: (from, to) => comparer.compare(from, to),
            activate: createActivateEndpoint(options.config),
            rollback: createRollbackEndpoint(options.config),
            pack: async (request) => {
              const asked = request as { build?: string; out?: string };
              return packBuild(options.config, { build: asked.build, out: asked.out });
            },
          },
        }
      : {}),
  });

  if (!isLoopback(options.host)) {
    // Architecture 15.3: binding beyond loopback is possible and never accidental.
    options.warn(
      `Warning: binding to ${options.host} exposes this build to your network. It is read-only, and it is still your documents.\n`,
    );
  }

  const server = await listen(app.fetch, options.host, options.port, options.warn);

  let closed = false;
  return {
    url: `http://${options.host}:${server.port}`,
    port: server.port,
    buildId: active.buildId,
    studio: serveStudio,
    close: async () => {
      if (closed) return;
      closed = true;
      // Order matters: `close()` stops new connections and waits for in-flight requests,
      // and only then are the databases released. Releasing first would let a request in
      // flight read a closed handle.
      await server.close();
      await mcp.close();
      backend.close();
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

/** Resolves on the first interrupt, so a caller can drain in its own order. */
export async function untilInterrupted(warn: (text: string) => void): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (signal: string): void => {
      warn(`\nStopping on ${signal}. Draining requests.\n`);
      resolve();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Milliseconds, or 0 for every request. `off` belongs to `lore mcp`, which can pin. */
export function parseInterval(raw: unknown): number {
  // `Number('')` is 0, and 0 is the most expensive setting there is: it content-hashes the
  // corpus on every request. Reaching it by writing nothing, which is what a shell does
  // with an unset variable, is not a choice anyone made (#195).
  const blank = typeof raw === 'string' && raw.trim() === '';
  const value = blank ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      `--revalidate-interval must be a number of milliseconds, got ${raw}.`,
      { remediation: 'Pass milliseconds, or 0 to recheck on every request.' },
    );
  }
  return value;
}

export function parsePort(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `--port must be a port number, got ${raw}.`, {
      remediation: `Pass a number between 1 and 65535, for example --port ${DEFAULT_PORT}.`,
    });
  }
  return value;
}
