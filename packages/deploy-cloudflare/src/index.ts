import type { BuildComparer, BuildId, LoreRuntime, SourceState } from '@lorepack/core';
import { createMcpHttpHandler } from '@lorepack/mcp';
import { type ApiOptions, createApiApp } from '@lorepack/runtime';
import type { Hono } from 'hono';

/**
 * The Cloudflare Worker-facing assembly of the shared REST and MCP surfaces.
 *
 * This package is where Phase 6 proves the Worker reuses the same route and tool
 * registrations as local. The projection-specific ports arrive later; the app shape is
 * already fixed here so those ports become injected storage, not forked handlers.
 */

export interface CloudflareRuntimeOptions {
  readonly runtime: LoreRuntime;
  readonly currentBuild: () => Promise<{ buildId: BuildId; generation: number } | null>;
  readonly freshness?: () => Promise<SourceState>;
  readonly authorize?: ApiOptions['authorize'];
  /**
   * Optional because a deployment may keep only the active build and genuinely have no
   * history to compare. Passing nothing keeps the resource registered and lets it answer
   * that fact rather than forking the MCP surface.
   */
  readonly comparer?: BuildComparer;
}

export interface CloudflareWorkerApp {
  readonly app: Hono;
  readonly fetch: (request: Request) => Promise<Response> | Response;
  readonly close: () => Promise<void>;
}

function createWorkerApp(
  options: CloudflareRuntimeOptions,
): CloudflareWorkerApp & { readonly apiOptions: ApiOptions } {
  const mcp = createMcpHttpHandler(options.runtime, options.comparer);
  const apiOptions: ApiOptions = {
    runtime: options.runtime,
    currentBuild: options.currentBuild,
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
    mcpHandler: (request) => mcp.fetch(request),
  };
  const app = createApiApp(apiOptions);
  return {
    app,
    apiOptions,
    fetch: (request) => app.fetch(request),
    close: () => mcp.close(),
  };
}

/** The remote shape: shared read-only routes, shared MCP surface, no local actions. */
export function createCloudflareWorkerApp(options: CloudflareRuntimeOptions): Hono {
  return createWorkerApp(options).app;
}

/**
 * The shape a Worker module export can delegate to.
 *
 * Returning `close()` keeps tests and local emulation able to release per-request transport
 * machinery explicitly, even though the real Worker runtime does not call it.
 */
export function createCloudflareWorker(options: CloudflareRuntimeOptions): CloudflareWorkerApp {
  const worker = createWorkerApp(options);
  return { app: worker.app, fetch: worker.fetch, close: worker.close };
}

export {
  D1ActiveBuildProvider,
  type D1DatabaseLike,
  type R2BucketLike,
  R2ObjectStore,
} from './storage.js';
export {
  type D1QueryDatabaseLike,
  type D1TableNamespace,
  D1TableStore,
  D1TableStore as D1NamespacedTableStore,
} from './tables.js';
