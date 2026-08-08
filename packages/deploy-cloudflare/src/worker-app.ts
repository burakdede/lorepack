import type { BuildComparer, BuildId, LoreRuntime, SourceState } from '@lorepack/core/worker';
import { createMcpHttpHandler } from '@lorepack/mcp';
import { type ApiOptions, createApiApp, createRuntime } from '@lorepack/runtime';
import type { Hono } from 'hono';
import {
  type D1CatalogDatabaseLike,
  type D1CatalogNamespace,
  D1CatalogStore,
  type D1CatalogStoreOptions,
} from './catalog.js';
import { assertProjectionReadable } from './projection-state.js';
import {
  D1ActiveBuildProvider,
  type D1DatabaseLike,
  type R2BucketLike,
  R2ObjectStore,
} from './storage.js';
import { type D1QueryDatabaseLike, type D1TableNamespace, D1TableStore } from './tables.js';

/**
 * Worker-safe assembly for the shared REST and MCP surfaces.
 *
 * Keep this module free of Node-only deploy helpers so the real Worker bundle can import it
 * directly without traversing archive upload or deployment-target code.
 */

export interface CloudflareRuntimeOptions {
  readonly runtime: LoreRuntime;
  readonly currentBuild: () => Promise<{ buildId: BuildId; generation: number } | null>;
  readonly freshness?: () => Promise<SourceState>;
  readonly authorize?: ApiOptions['authorize'];
  readonly comparer?: BuildComparer;
}

export interface CloudflareWorkerApp {
  readonly app: Hono;
  readonly fetch: (request: Request) => Promise<Response> | Response;
  readonly close: () => Promise<void>;
}

export interface CloudflareBindings {
  readonly CATALOG_DB: D1DatabaseLike & D1CatalogDatabaseLike & D1QueryDatabaseLike;
  readonly OBJECTS: R2BucketLike;
  readonly PROJECT_ID: string;
}

export interface CloudflareBoundWorkerOptions {
  readonly freshness?: () => Promise<SourceState>;
  readonly authorize?: ApiOptions['authorize'];
  readonly comparer?: BuildComparer;
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

export function createCloudflareWorkerApp(options: CloudflareRuntimeOptions): Hono {
  return createWorkerApp(options).app;
}

export function createCloudflareWorker(options: CloudflareRuntimeOptions): CloudflareWorkerApp {
  const worker = createWorkerApp(options);
  return { app: worker.app, fetch: worker.fetch, close: worker.close };
}

function namespaceOf(bindings: CloudflareBindings, buildId: BuildId): D1CatalogNamespace {
  return { projectId: bindings.PROJECT_ID, buildId };
}

export function createCloudflareWorkerFromBindings(
  bindings: CloudflareBindings,
  options: CloudflareBoundWorkerOptions = {},
): CloudflareWorkerApp {
  const provider = new D1ActiveBuildProvider(bindings.CATALOG_DB);
  const runtime = createRuntime({
    provider,
    open: async (handle) => {
      const namespace = namespaceOf(bindings, handle.buildId);
      await assertProjectionReadable(bindings.CATALOG_DB, namespace);
      return {
        buildId: handle.buildId,
        catalog: new D1CatalogStore({
          db: bindings.CATALOG_DB,
          namespace,
        }),
        tables: new D1TableStore(bindings.CATALOG_DB, namespace),
        objects: new R2ObjectStore(bindings.PROJECT_ID, bindings.OBJECTS),
      };
    },
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
  });

  return createCloudflareWorker({
    runtime,
    currentBuild: () => provider.current(),
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
    ...(options.comparer === undefined ? {} : { comparer: options.comparer }),
  });
}

export type {
  D1CatalogDatabaseLike,
  D1CatalogNamespace,
  D1CatalogStoreOptions,
  D1DatabaseLike,
  D1QueryDatabaseLike,
  D1TableNamespace,
  R2BucketLike,
};

