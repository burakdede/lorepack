import {
  type BuildId,
  LoreError,
  type LoreRuntime,
  renderAsJson,
  type SourceState,
  searchRequestSchema,
  secretsFromEnv,
  tableQueryRequestSchema,
  taskContextRequestSchema,
} from '@lorepack/core';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { ZodType } from 'zod';

/**
 * The REST surface, architecture 14.5.
 *
 * Every handler depends on `LoreRuntime` and nothing else. No SQLite type, no Cloudflare
 * binding and no filesystem call appears here, which is what makes the Phase 6 projection a
 * configuration change rather than a rewrite: the same app object is handed to
 * `@hono/node-server` locally and to a Worker's `fetch` export remotely.
 *
 * Read-only by construction (architecture 19.4). There is no route that builds, deploys,
 * edits a source or runs a command, and there is nowhere to add one without changing this
 * file, which is the point of keeping the whole surface in one place.
 */

export interface ApiOptions {
  readonly runtime: LoreRuntime;
  /**
   * The MCP Streamable HTTP handler, mounted at `POST /mcp`.
   *
   * Injected rather than constructed here because `@lorepack/runtime` may not import the
   * MCP SDK: protocol churn is isolated in one package (architecture 8.6), and this app has
   * to keep compiling on a Worker whether or not that package is present.
   */
  readonly mcpHandler?: (request: Request) => Promise<Response> | Response;
  /**
   * Studio's built assets, served at the root.
   *
   * Injected for the same reason `mcpHandler` is: reading files from a disk is a Node
   * concern, and this app also has to compile for a Worker that has no filesystem. It
   * returns `null` for anything it does not have, so an unknown path still reaches the
   * typed 404 below rather than being swallowed.
   *
   * Registered after every `/v1` route, so an asset can never shadow the API.
   */
  readonly assets?: (request: Request) => Promise<Response | null> | Response | null;
  /**
   * The active build, for `/health`. Separate from the runtime because architecture 13.1
   * fixes that interface at seven capabilities and a health probe is not one of them.
   */
  readonly currentBuild: () => Promise<{ buildId: BuildId; generation: number } | null>;
  readonly freshness?: () => Promise<SourceState>;
  /**
   * Browser origins allowed to call this API. Empty by default, which refuses every
   * cross-origin browser request. Studio adds its own in Phase 4.
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * Also accept a browser page served from a loopback address.
   *
   * Set when Studio is mounted, because Studio is served by this same app and its own
   * subresource and API requests carry an `Origin` naming the loopback host it was loaded
   * from. The port is not known when this app is constructed (it is chosen by trying), so
   * the rule is expressed as a property of the origin rather than as a literal.
   *
   * This does not weaken the DNS rebinding defence, which is the reason the check exists.
   * Rebinding works by making a hostname the attacker controls resolve to `127.0.0.1`, and
   * the browser puts that **hostname** in `Origin`, not the resolved address. So an attacker
   * page is `https://evil.example` and is still refused; only a page genuinely served from a
   * loopback literal produces a loopback origin.
   */
  readonly allowLoopbackOrigin?: boolean;
  /**
   * What a rebuild would change, computed on demand.
   *
   * An injected host function rather than a runtime capability, for the same reason
   * `currentBuild` is one: architecture 13.1 fixes `LoreRuntime` at seven capabilities that
   * read the *active build*, and a plan reads the **source tree**. A deployment that holds
   * only the build it serves has no sources to plan against and supplies nothing, which is
   * exactly the distinction a separate port expresses.
   *
   * Deliberately never polled. Planning walks and fingerprints the corpus, so Studio asks
   * for it when a person asks for it.
   */
  readonly plan?: () => Promise<unknown>;
  /** The active build's warnings, with class and path, for the Overview summary. */
  readonly warnings?: () => Promise<unknown>;
  /**
   * Every artifact in the active build, for the Sources tree.
   *
   * Reads `CatalogStore.artifacts()`, which is a storage question rather than a retrieval
   * one, so it stays off `LoreRuntime` and its seven capabilities.
   */
  readonly sources?: () => Promise<unknown>;
  /** Largest request body accepted, in bytes. */
  readonly maxRequestBytes?: number;
  /**
   * Decides whether a request may proceed, before any route runs.
   *
   * Absent by default, which is what a loopback server wants: the person who started it is
   * the only one who can reach it, and asking them for a token they issued to themselves
   * protects nothing. A remote deployment is the opposite case, and Phase 6 supplies a
   * bearer check here rather than forking the app (architecture 18.4).
   *
   * Returning `false`, or a reason, refuses the request as `401`. `/health` is always
   * exempt: a load balancer has no credential, and the probe reveals nothing but liveness.
   */
  readonly authorize?: (request: AuthorizationRequest) => AuthorizationDecision;
}

export interface AuthorizationRequest {
  /** The `Authorization` header verbatim, or undefined when the client sent none. */
  readonly authorization: string | undefined;
  readonly method: string;
  readonly path: string;
  /** Every header, for a scheme that needs more than one. */
  readonly headers: Headers;
}

/** `true` admits the request. `false` or a reason refuses it. */
export type AuthorizationDecision = boolean | string | Promise<boolean | string>;

/** The one path that runs before authorization, so liveness never needs a credential. */
export const UNAUTHENTICATED_PATHS: readonly string[] = ['/health'];

/** A megabyte is far more than any request here needs, and far less than a memory problem. */
export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;

export function createApiApp(options: ApiOptions): Hono {
  const app = new Hono();
  const allowed = new Set(options.allowedOrigins ?? []);
  const maxBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;

  /**
   * Origin checking, which is the defence a loopback server actually needs.
   *
   * A page on any website can make a request to `127.0.0.1`, and DNS rebinding can make
   * that request look same-origin to the browser. A non-browser client (the SDK, an MCP
   * host, curl) sends no `Origin` header at all, so refusing every unrecognised origin
   * costs those nothing and closes the hole. `/health` is exempt so a browser can probe
   * liveness without learning anything: it returns no content.
   */
  app.use('*', async (context, next) => {
    const origin = context.req.header('Origin');
    const permitted =
      origin === undefined ||
      allowed.has(origin) ||
      (options.allowLoopbackOrigin === true && isLoopbackOrigin(origin));

    if (!permitted && context.req.path !== '/health') {
      return failure(
        context,
        new LoreError('LORE_E_INVALID_ARGUMENT', 'This origin may not call the Lorepack API.', {
          remediation:
            'Requests from a browser page must come from an allowed origin. Tools and SDKs send no Origin header and are unaffected.',
          subject: origin,
        }),
        403,
      );
    }
    return next();
  });

  /**
   * Authorization, after the origin check and before every route but `/health`.
   *
   * Placed here rather than per route so a route added later is protected by existing, not
   * by its author remembering. The decision is the host's: this app knows nothing about
   * tokens, and a local server passes no hook at all.
   */
  if (options.authorize !== undefined) {
    const authorize = options.authorize;
    app.use('*', async (context, next) => {
      if (UNAUTHENTICATED_PATHS.includes(context.req.path)) return next();

      const decision = await authorize({
        authorization: context.req.header('Authorization'),
        method: context.req.method,
        path: context.req.path,
        headers: context.req.raw.headers,
      });
      if (decision === true) return next();

      return failure(
        context,
        new LoreError(
          'LORE_E_INVALID_ARGUMENT',
          typeof decision === 'string' ? decision : 'This request is not authorized.',
          {
            remediation:
              'Send the credential this deployment requires in the Authorization header.',
          },
        ),
        401,
      );
    });
  }

  app.get('/health', async (context) => {
    const active = await options.currentBuild();
    const sourceState = options.freshness === undefined ? 'unknown' : await options.freshness();
    return context.json({
      status: active === null ? 'no-build' : 'ok',
      buildId: active?.buildId ?? null,
      generation: active?.generation ?? null,
      sourceState,
    });
  });

  if (options.mcpHandler !== undefined) {
    const handler = options.mcpHandler;
    // Every method: the transport answers GET and DELETE itself, including refusing them
    // where the stateless model has nothing to answer with.
    app.all('/mcp', async (context) => handler(context.req.raw));
  }

  app.get('/v1/build', (context) => answer(context, () => options.runtime.describeBuild()));

  // Studio-facing reads that are not runtime capabilities. Absent unless the host supplies
  // them, so a deployment without sources simply does not have these routes.
  if (options.plan !== undefined) {
    const plan = options.plan;
    app.get('/v1/plan', (context) => answer(context, () => plan()));
  }
  if (options.warnings !== undefined) {
    const warnings = options.warnings;
    app.get('/v1/warnings', (context) => answer(context, () => warnings()));
  }
  if (options.sources !== undefined) {
    const sources = options.sources;
    app.get('/v1/sources', (context) => answer(context, () => sources()));
  }

  app.post('/v1/search', async (context) =>
    answer(context, async () =>
      options.runtime.search(await body(context, searchRequestSchema, maxBytes)),
    ),
  );

  app.post('/v1/context', async (context) =>
    answer(context, async () =>
      options.runtime.contextForTask(await body(context, taskContextRequestSchema, maxBytes)),
    ),
  );

  /**
   * The artifact is a path parameter, so it arrives as text. It is looked up in the build
   * and nothing else: a traversal or an absolute path is simply an artifact this build does
   * not have, which is what makes it a miss rather than a hazard.
   */
  app.get('/v1/sources/:artifactId', async (context) =>
    answer(context, async () => {
      const artifactId = decodeURIComponent(context.req.param('artifactId'));
      const query = context.req.query();
      return options.runtime.readSource({
        artifactId,
        ...numeric('lineStart', query.lineStart),
        ...numeric('lineEnd', query.lineEnd),
        ...(query.headingPath === undefined
          ? {}
          : { headingPath: query.headingPath.split('>').map((part) => part.trim()) }),
      });
    }),
  );

  app.get('/v1/tables', (context) =>
    answer(context, async () => ({ tables: await options.runtime.listTables() })),
  );

  app.get('/v1/tables/:tableId', (context) =>
    answer(context, () => options.runtime.describeTable(context.req.param('tableId'))),
  );

  app.post('/v1/tables/:tableId/query', async (context) =>
    answer(context, async () => {
      const parsed = await body(context, tableQueryRequestSchema, maxBytes, {
        tableId: context.req.param('tableId'),
      });
      return options.runtime.queryTable(parsed);
    }),
  );

  // Studio, if the host supplied it. After the API, before the 404.
  //
  // API prefixes are excluded rather than relying on route order. Studio is a hash-routed
  // app, so its handler answers any unmatched path with the entry document, and without this
  // guard `GET /v1/nope` would return that document with a 200 instead of the typed 404 the
  // error contract promises. Route order alone does not prevent it, because an unmatched
  // `/v1` path is exactly what falls through to here.
  if (options.assets !== undefined) {
    const assets = options.assets;
    app.get('*', async (context, next) => {
      if (isApiPath(context.req.path)) return next();
      const response = await assets(context.req.raw);
      if (response === null) return next();
      return response;
    });
  }

  // Anything else. A 404 in the same typed shape as every other failure, so a client has
  // one error format to handle rather than two.
  app.all('*', (context) =>
    failure(
      context,
      new LoreError('LORE_E_INVALID_ARGUMENT', `No route ${context.req.path}.`, {
        remediation: 'See the documented route list. This API is read-only and has no other paths.',
        subject: context.req.path,
      }),
      404,
    ),
  );

  return app;
}

/**
 * Whether an origin names this machine by a loopback literal.
 *
 * Only literals count. A hostname that merely resolves to a loopback address is exactly the
 * DNS rebinding case, and it arrives in `Origin` as the hostname, so it fails here.
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

/** Paths the API owns, whose failures must stay typed rather than becoming the Studio shell. */
function isApiPath(path: string): boolean {
  return path === '/health' || path === '/mcp' || path.startsWith('/v1/') || path === '/v1';
}

async function answer(context: Context, body: () => Promise<unknown>): Promise<Response> {
  try {
    return context.json((await body()) as Record<string, unknown>);
  } catch (error) {
    return failure(context, error, statusFor(error));
  }
}

/**
 * Parses and validates a request body, reporting the exact JSON path that was wrong.
 *
 * "Body is invalid" sends a caller back to guess. Naming `filters[0].kind` does not.
 */
async function body<T>(
  context: Context,
  schema: ZodType<T>,
  maxBytes: number,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const declared = Number(context.req.header('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge(declared, maxBytes);
  }

  const text = await context.req.text();
  // The declared length is a claim, so the real one is checked too.
  if (byteLength(text) > maxBytes) throw tooLarge(byteLength(text), maxBytes);

  let raw: unknown;
  try {
    raw = text === '' ? {} : JSON.parse(text);
  } catch (cause) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', 'The request body is not valid JSON.', {
      remediation: 'Send a JSON object with the fields this route documents.',
      cause,
    });
  }

  const result = schema.safeParse({ ...(raw as Record<string, unknown>), ...extra });
  if (result.success) return result.data;

  const first = result.error.issues[0];
  const path = first === undefined ? '' : first.path.join('.');
  throw new LoreError(
    'LORE_E_INVALID_ARGUMENT',
    `The request body is invalid${path === '' ? '' : ` at \`${path}\``}: ${first?.message ?? 'unknown reason'}.`,
    {
      remediation: 'Correct the named field and try again.',
      ...(path === '' ? {} : { subject: path }),
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    },
  );
}

function tooLarge(actual: number, limit: number): LoreError {
  return new LoreError('LORE_E_LIMIT_EXCEEDED', 'The request body is too large.', {
    remediation: `This API accepts at most ${limit} bytes; the request declared ${actual}.`,
  });
}

function failure(context: Context, error: unknown, status: number): Response {
  // Rendered through the Phase 0 taxonomy, so redaction happens once rather than at every
  // call site, and an accidentally embedded token cannot leave the process.
  const rendered = renderAsJson(error, { secrets: secretsFromEnv() });
  return context.json(rendered, status as 400);
}

/**
 * HTTP status from the error's own classification.
 *
 * The code is the contract; the status is a courtesy for tools that only speak HTTP. A
 * caller that needs to branch reads `error.code`.
 */
function statusFor(error: unknown): number {
  const code = LoreError.from(error).code;
  if (code === 'LORE_E_BUILD_NOT_FOUND') return 404;
  if (code === 'LORE_E_INVALID_ARGUMENT') return 400;
  if (code === 'LORE_E_LIMIT_EXCEEDED') return 413;
  if (code === 'LORE_E_SQL_REJECTED') return 400;
  if (code === 'LORE_E_INTERNAL') return 500;
  return 500;
}

function numeric(name: 'lineStart' | 'lineEnd', raw: string | undefined): Record<string, number> {
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `${name} must be a positive whole number.`, {
      remediation: `Pass ${name} as a line number, for example ${name}=12.`,
      subject: raw,
    });
  }
  return { [name]: value };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
