import {
  type BuildComparer,
  type BuildId,
  LoreError,
  type LoreRuntime,
  type SourceState,
} from '@lorepack/core/worker';
import { createMcpHttpHandler } from '@lorepack/mcp';
import { type ApiOptions, createApiApp, createRuntime } from '@lorepack/runtime';
import type { Hono } from 'hono';
import {
  ACCESS_JWT_HEADER,
  type CloudflareAccessBindings,
  type CloudflareAccessConfig,
  createCloudflareRequestAuthorizer,
  resolveCloudflareAccessConfigFromBindings,
} from './access-auth.js';
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
  readonly allowedOrigins?: readonly string[];
  readonly comparer?: BuildComparer;
}

export interface CloudflareWorkerApp {
  readonly app: Hono;
  readonly fetch: (request: Request) => Promise<Response> | Response;
  readonly close: () => Promise<void>;
}

/** A Workers Rate Limiting binding, as the runtime provides it. */
export interface RateLimitLike {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

export interface CloudflareBindings {
  readonly CATALOG_DB: D1DatabaseLike & D1CatalogDatabaseLike & D1QueryDatabaseLike;
  readonly TABLES_DB: D1QueryDatabaseLike;
  /** Table queries per caller, declared in `wrangler.jsonc` (#558). */
  readonly TABLE_QUERY_LIMITER?: RateLimitLike;
  readonly OBJECTS: R2BucketLike;
  readonly PROJECT_ID: string;
  readonly ALLOWED_ORIGINS?: string;
  readonly CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  readonly CLOUDFLARE_ACCESS_AUD?: string;
}

export interface CloudflareBoundWorkerOptions {
  readonly authMode?: 'runtime-token' | 'disabled';
  readonly freshness?: () => Promise<SourceState>;
  readonly authorize?: ApiOptions['authorize'];
  readonly allowedOrigins?: readonly string[];
  readonly access?: CloudflareAccessConfig;
  readonly comparer?: BuildComparer;
  /**
   * Who is asking, as `tableQueryCaller` derives it from the request. When set, every table
   * query is counted against that caller by `TABLE_QUERY_LIMITER`, and refused when the
   * binding is missing. The deployed Worker always sets it; an assembly that serves no
   * untrusted caller, such as a test, may leave it out.
   */
  readonly tableQueryCaller?: string;
}

const WORKER_SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

const CORS_ALLOWED_HEADERS = 'Authorization, Content-Type, Accept, Mcp-Method, Mcp-Name';
const CORS_ALLOWED_METHODS = 'GET, POST, OPTIONS';
const CORS_MAX_AGE_SECONDS = '600';

function createWorkerApp(
  options: CloudflareRuntimeOptions,
): CloudflareWorkerApp & { readonly apiOptions: ApiOptions } {
  const mcp = createMcpHttpHandler(options.runtime, options.comparer, { host: 'cloudflare' });
  const apiOptions: ApiOptions = {
    runtime: options.runtime,
    currentBuild: options.currentBuild,
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
    mcpHandler: (request) => mcp.fetch(request),
  };
  const app = createApiApp(apiOptions);
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  return {
    app,
    apiOptions,
    fetch: async (request) => {
      const origin = request.headers.get('Origin');
      if (isCorsPreflight(request) && origin !== null && allowedOrigins.has(origin)) {
        return withWorkerHeaders(new Response(null, { status: 204 }), origin);
      }
      const response = await app.fetch(request);
      return withWorkerHeaders(
        response,
        origin !== null && allowedOrigins.has(origin) ? origin : null,
        request.url,
      );
    },
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
  bindings: CloudflareBindings & CloudflareAccessBindings,
  options: CloudflareBoundWorkerOptions = {},
): CloudflareWorkerApp {
  const provider = new D1ActiveBuildProvider(bindings.CATALOG_DB);
  const authMode = options.authMode ?? 'disabled';
  const access = options.access ?? resolveCloudflareAccessConfigFromBindings(bindings);
  const authorize =
    options.authorize ??
    createCloudflareRequestAuthorizer({
      ...(access === undefined ? {} : { access }),
      ...(authMode === 'runtime-token' ? { runtimeAuthDb: bindings.CATALOG_DB } : {}),
    });
  const allowedOrigins = options.allowedOrigins ?? parseAllowedOrigins(bindings.ALLOWED_ORIGINS);
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
        tables: new D1TableStore(
          bindings.CATALOG_DB,
          namespace,
          bindings.TABLES_DB,
          options.tableQueryCaller === undefined
            ? {}
            : {
                admitQuery: tableQueryAdmission(
                  bindings.TABLE_QUERY_LIMITER,
                  options.tableQueryCaller,
                ),
              },
        ),
        objects: new R2ObjectStore(bindings.PROJECT_ID, bindings.OBJECTS),
      };
    },
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
  });

  return createCloudflareWorker({
    runtime,
    currentBuild: () => provider.current(),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
    ...(authorize === undefined ? {} : { authorize }),
    ...(options.comparer === undefined ? {} : { comparer: options.comparer }),
  });
}

/**
 * The key a caller's table queries are counted under: a SHA-256 of the credential it
 * presented, so the limit follows a runtime token or an Access session rather than an IP
 * address that many callers may share, and the key never holds the credential itself.
 * Authorization still decides whether the request runs at all; this only names who sent it.
 */
export async function tableQueryCaller(request: Request): Promise<string> {
  const credential =
    request.headers.get('Authorization') ?? request.headers.get(ACCESS_JWT_HEADER) ?? '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `table-query:${hex}`;
}

/**
 * The runtime bound on remote table queries (#558).
 *
 * The statement guard bounds the rows a statement can form, but not what each row costs, and
 * D1 runs one query at a time per database without any way to stop it before its own 30
 * second limit. So the number of queries one caller may start is limited here, before any
 * reaches D1. Fails closed: a Worker deployed without the binding refuses table queries
 * rather than serving them unbounded.
 */
function tableQueryAdmission(
  limiter: RateLimitLike | undefined,
  caller: string,
): () => Promise<void> {
  return async () => {
    if (limiter === undefined) {
      throw new LoreError(
        'LORE_E_TARGET_NOT_CONFIGURED',
        'This deployment has no table query rate limit, so table queries are refused.',
        {
          remediation:
            'Add the `TABLE_QUERY_LIMITER` rate limit binding from `packages/deploy-cloudflare/wrangler.jsonc` to the Worker configuration and deploy it again.',
        },
      );
    }
    const { success } = await limiter.limit({ key: caller });
    if (!success) {
      throw new LoreError(
        'LORE_E_BUSY',
        'This caller has made too many table queries in the last minute.',
        {
          remediation:
            'Wait a minute before querying again, and combine questions into fewer queries where you can. The build was not modified.',
        },
      );
    }
  };
}

function withWorkerHeaders(response: Response, origin: string | null, url?: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(WORKER_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  if (url !== undefined && new URL(url).protocol === 'https:') {
    headers.set('Strict-Transport-Security', 'max-age=31536000');
  }
  if (origin !== null) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
    headers.set('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
    headers.set('Access-Control-Max-Age', CORS_MAX_AGE_SECONDS);
    appendVary(headers, 'Origin');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get('Vary');
  if (current === null || current.trim() === '') {
    headers.set('Vary', value);
    return;
  }
  const values = current.split(',').map((entry) => entry.trim());
  if (!values.includes(value)) headers.set('Vary', `${current}, ${value}`);
}

function isCorsPreflight(request: Request): boolean {
  return (
    request.method === 'OPTIONS' &&
    request.headers.has('Origin') &&
    request.headers.has('Access-Control-Request-Method')
  );
}

function parseAllowedOrigins(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return parsed.length === 0 ? undefined : parsed;
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
