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
import {
  type ProjectArchiveUploadOptions,
  type ProjectArchiveUploadResult,
  uploadProjectArchive,
} from './project-archive.js';
import {
  type ProjectObjectUploadOptions,
  type ProjectObjectUploadResult,
  uploadProjectObjects,
} from './project-objects.js';
import type {
  ProjectionMigrationDatabaseLike,
  ProjectionMigrationStatementLike,
} from './projection-migrations.js';
import { assertProjectionReadable } from './projection-state.js';
import { r2ArchiveKey, r2ObjectKey } from './r2-keys.js';
import {
  D1ActiveBuildProvider,
  type D1DatabaseLike,
  type R2BucketLike,
  R2ObjectStore,
} from './storage.js';
import { type D1QueryDatabaseLike, type D1TableNamespace, D1TableStore } from './tables.js';
import {
  CloudflareApplyError,
  type CloudflareDeploymentTargetOptions,
  createCloudflareDeploymentTarget,
} from './target.js';

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
  CloudflareDeploymentTargetOptions,
  D1CatalogDatabaseLike,
  D1CatalogNamespace,
  D1CatalogStoreOptions,
  D1DatabaseLike,
  D1QueryDatabaseLike,
  D1TableNamespace,
  ProjectArchiveUploadOptions,
  ProjectArchiveUploadResult,
  ProjectionMigrationDatabaseLike,
  ProjectionMigrationStatementLike,
  ProjectObjectUploadOptions,
  ProjectObjectUploadResult,
  R2BucketLike,
};
export {
  CloudflareApplyError,
  createCloudflareDeploymentTarget,
  D1ActiveBuildProvider,
  D1CatalogStore,
  D1TableStore as D1NamespacedTableStore,
  D1TableStore,
  R2ObjectStore,
  r2ArchiveKey,
  r2ObjectKey,
  uploadProjectArchive,
  uploadProjectObjects,
};
