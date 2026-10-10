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
} from '@lorepack/core/worker';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type ZodType, z } from 'zod';

/**
 * The REST surface, architecture 14.5.
 *
 * Every handler depends on `LoreRuntime` and nothing else. No SQLite type, no Cloudflare
 * binding and no filesystem call appears here, which is what makes the Phase 6 projection a
 * configuration change rather than a rewrite: the same app object is handed to
 * `@hono/node-server` locally and to a Worker's `fetch` export remotely.
 *
 * Read-only by default, and the exception is bounded. No route builds, deploys, edits a
 * source or runs a command. The `/v1/builds` routes can move the active pointer, and they
 * exist only where a host passed `localActions`, which only the local CLI does. Keeping the
 * whole surface in one file is what makes that boundary checkable: there is nowhere to add a
 * write without editing these lines.
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
   * The hostnames this server answers to, checked against `Host` before any route runs.
   *
   * This, not the `Origin` check, is the DNS rebinding defence (#547). After a rebind the
   * attacker's page is same-origin with this server, and a browser sends no `Origin` on a
   * same-origin `GET`, so every read would pass an origin check. The `Host` header is what the
   * attacker cannot change: it names the hostname in the URL the page fetched, which is theirs.
   *
   * Hostnames only, compared case-insensitively, with IPv6 literals in brackets (`[::1]`). The
   * port is not compared: a rebinding attack uses this server's own port, and an SSH tunnel or
   * a dev proxy legitimately reaches it through another. The local CLI derives one list from
   * the bind address and hands the same list to the MCP transport. Absent, nothing is
   * checked, which is a Worker: it is reached by its own hostname and authenticates instead.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Also accept a browser page this server itself served: one whose `Origin` names the same
   * host and port as the request's `Host`.
   *
   * Set when Studio is mounted, because Studio is served by this same app and its API
   * requests carry an `Origin` naming the address it was loaded from. Same-origin rather than
   * "any loopback origin" (#548): another server on this machine, on another port, is a
   * loopback origin too, and it is not Studio. Compared per request against `Host` rather
   * than against a literal, because the port is chosen by trying after this app is built,
   * and because a dev proxy or tunnel serves Studio on a port of its own.
   *
   * Only meaningful when `allowedHosts` is set: without it, a rebound page is same-origin
   * with whatever `Host` it sends. So `createApiApp` refuses this option without that one.
   */
  readonly allowSameOrigin?: boolean;
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
  /**
   * The same Markdown `lorepack export` writes, for the same inputs.
   *
   * Rendered on the server rather than in the browser, because "what you see is what a chat
   * product gets" is only true if one renderer produces both. A second implementation in
   * Studio would drift on the first wording change, and the drift would be invisible: both
   * outputs would look plausible.
   */
  readonly exportBundle?: (request: unknown) => Promise<string>;
  /**
   * Environment checks and live session state, for Studio's Diagnostics route.
   *
   * An injected host function rather than an eighth runtime capability, for the same reason
   * `currentBuild` is one: architecture 13.1 fixes `LoreRuntime` at seven capabilities that
   * read the active build, and a diagnostic reads the *machine*. Probing SQLite and counting
   * watched paths is not a question about a build, and a deployment answers it differently
   * or not at all.
   */
  readonly diagnostics?: () => Promise<unknown>;
  /**
   * The actions that change which build is live, and the history they act on.
   *
   * The only writes in this API, and the reason they are one optional bundle rather than five
   * independent options: a host either can change this project's builds or it cannot, and a
   * partial set is not a configuration anyone wants. A deployment that supplies nothing here
   * does not have these routes at all, which is stronger than having them and refusing.
   *
   * Model-facing MCP tools never reach them (invariant 10). These belong to Studio, which is
   * loopback-bound, and the routes below refuse any browser page except a same-origin one on
   * a loopback name, regardless of what `allowedOrigins` permits for reads.
   */
  readonly localActions?: LocalActions;
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

export interface LocalActions {
  /** Every build this project has, newest first, with the active one marked. */
  readonly builds: () => Promise<unknown>;
  /** Section 18.3's comparison of any two builds, neither of which need be active. */
  readonly diff: (from: string, to: string) => Promise<unknown>;
  /** Moves the active pointer. Never recompiles (section 18.4). */
  readonly activate: (request: unknown) => Promise<unknown>;
  /** Moves the pointer back to the previous verified build. */
  readonly rollback: (request: unknown) => Promise<unknown>;
  /** Writes a `.lorepack` archive and reports where it went. */
  readonly pack: (request: unknown) => Promise<unknown>;
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

/**
 * A build is named by its id or by a unique prefix, the same way the CLI accepts one.
 *
 * Defined here rather than in `@lorepack/core` because this is not part of the runtime
 * contract every backend implements. It is the shape of two local requests.
 */
const activateRequestSchema = z.object({ build: z.string().min(1) }).strict();
/**
 * No `out`: an HTTP caller never chooses where a file is written (#548). The archive goes to
 * the default name in the project root, and `lorepack pack --out` remains the way to pick
 * another place, from a terminal, as the person who owns the files.
 */
const packRequestSchema = z.object({ build: z.string().min(1).optional() }).strict();
/**
 * `expect` is the build the caller was shown before confirming. Optional, because a script
 * rolling back has nothing to have been shown; supplied by Studio, so a confirmation that
 * went stale is refused rather than applied to a different build.
 */
const rollbackRequestSchema = z.object({ expect: z.string().min(1).optional() }).strict();

/** The one path that runs before authorization, so liveness never needs a credential. */
export const UNAUTHENTICATED_PATHS: readonly string[] = ['/health'];

/** A megabyte is far more than any request here needs, and far less than a memory problem. */
export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;

const HEADER_MISMATCH_ERROR_CODE = -32020;
const MCP_NAME_HEADER_SOURCE: Readonly<Record<string, 'name' | 'uri'>> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

export function createApiApp(options: ApiOptions): Hono {
  const app = new Hono();
  const allowed = new Set(options.allowedOrigins ?? []);
  if (options.allowSameOrigin === true && options.allowedHosts === undefined) {
    throw new LoreError(
      'LORE_E_INTERNAL',
      'allowSameOrigin needs allowedHosts: a same-origin check against an unchecked Host admits a DNS-rebound page.',
    );
  }
  const maxBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;

  /**
   * Host checking, first, so a rebound request reaches nothing: not `/health`, not `/mcp`,
   * not a Studio asset. See `ApiOptions.allowedHosts` for why this and not `Origin`.
   */
  if (options.allowedHosts !== undefined) {
    const hosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    app.use('*', async (context, next) => {
      const host = context.req.header('Host');
      if (host !== undefined && hosts.has(hostnameOf(host) ?? '')) return next();
      return failure(
        context,
        new LoreError('LORE_E_INVALID_ARGUMENT', 'This server does not answer to that host name.', {
          remediation:
            'Use the address `lorepack dev` or `lorepack serve` printed. A reverse proxy in front of Lorepack must forward the original loopback Host header.',
          ...(host === undefined ? {} : { subject: host }),
        }),
        403,
      );
    });
  }

  /**
   * Origin checking, which stops a page on another site from calling this API.
   *
   * A page on any website can make a request to `127.0.0.1`. A non-browser client (the SDK,
   * an MCP host, curl) sends no `Origin` header at all, so refusing every unrecognised origin
   * costs those nothing. It does not stop DNS rebinding: a rebound page is same-origin, and a
   * same-origin `GET` carries no `Origin`. The `Host` check above is what does. `/health` is
   * exempt so a browser can probe liveness without learning anything: it returns no content.
   */
  app.use('*', async (context, next) => {
    const origin = context.req.header('Origin');
    const permitted =
      origin === undefined ||
      allowed.has(origin) ||
      (options.allowSameOrigin === true && isSameOrigin(origin, context.req.header('Host')));

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

  /**
   * The body cap, counted as the body streams in rather than after it has (#550).
   *
   * A chunked upload declares no length, so checking `Content-Length` alone let a client make
   * this process buffer as much as it cared to send. `bodyLimit` reads at most `maxBytes` and
   * then answers `413` without reading the rest. After authorization, so an anonymous caller
   * costs no read at all, and before every route, `/mcp` included: the MCP adapter parses
   * whatever body it is handed.
   */
  app.use(
    '*',
    bodyLimit({
      maxSize: maxBytes,
      onError: (context) => failure(context, tooLarge(maxBytes), 413),
    }),
  );

  /**
   * `Mcp-Method` and `Mcp-Name` must agree with the body they mirror, before the handler
   * runs, so a policy that routes on those headers cannot be steered by a forged one.
   *
   * After the hook rather than before it (#550): checking means parsing the body, and parsing
   * an anonymous caller's body is work the caller chooses the size of. No hook here reads
   * these headers. Only where a hook exists, because that is a remote deployment, which is
   * where something in front of it may route on them.
   */
  if (options.authorize !== undefined) {
    app.use('/mcp', async (context, next) => {
      const mismatch = await validateMcpHeaders(context.req.raw);
      if (mismatch !== null) return mismatch;
      return next();
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
  if (options.diagnostics !== undefined) {
    const diagnostics = options.diagnostics;
    app.get('/v1/diagnostics', (context) => answer(context, () => diagnostics()));
  }
  if (options.exportBundle !== undefined) {
    const exportBundle = options.exportBundle;
    app.post('/v1/export', async (context) => {
      try {
        const parsed = await body(context, taskContextRequestSchema, maxBytes);
        // Markdown, not JSON: this is the artifact a person pastes, and wrapping it in a
        // JSON string would make every reader unwrap it before it was useful.
        return new Response(await exportBundle(parsed), {
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        });
      } catch (error) {
        return failure(context, error, statusFor(error));
      }
    });
  }

  /**
   * The write surface, present only where a host supplied one.
   *
   * Two independent things keep these off a remote deployment. A Worker has no build history
   * to hand over, so it supplies no `localActions` and these routes are never registered.
   * And where they are registered, a browser page must be the one this server served from a
   * loopback name, which `allowedOrigins` cannot widen: a deployment that added a remote
   * origin for reads has not thereby granted it the ability to activate a build, and another
   * localhost server on another port is not Studio (#548).
   */
  if (options.localActions !== undefined) {
    const actions = options.localActions;

    const loopbackOnly = async (
      context: Context,
      next: () => Promise<void>,
    ): Promise<Response | undefined> => {
      const origin = context.req.header('Origin');
      if (
        origin === undefined ||
        (options.allowSameOrigin === true &&
          isLoopbackOrigin(origin) &&
          isSameOrigin(origin, context.req.header('Host')))
      ) {
        await next();
        return undefined;
      }
      return failure(
        context,
        new LoreError(
          'LORE_E_INVALID_ARGUMENT',
          'Only a page served from this machine may change which build is active.',
          {
            remediation:
              'Open Studio at the address `lorepack dev` printed. These actions are deliberately unavailable to any other origin.',
            subject: origin,
          },
        ),
        403,
      );
    };
    // Both patterns: `/v1/builds/*` does not match `/v1/builds` itself, and a guard that
    // silently covers four routes out of five is worse than none.
    app.use('/v1/builds', loopbackOnly);
    app.use('/v1/builds/*', loopbackOnly);

    app.get('/v1/builds', (context) => answer(context, () => actions.builds()));

    app.get('/v1/builds/:from/diff/:to', (context) =>
      answer(context, () => actions.diff(context.req.param('from'), context.req.param('to'))),
    );

    app.post('/v1/builds/activate', async (context) =>
      answer(context, async () =>
        actions.activate(await body(context, activateRequestSchema, maxBytes)),
      ),
    );

    app.post('/v1/builds/rollback', async (context) =>
      answer(context, async () =>
        actions.rollback(await body(context, rollbackRequestSchema, maxBytes)),
      ),
    );

    app.post('/v1/builds/pack', async (context) =>
      answer(context, async () => actions.pack(await body(context, packRequestSchema, maxBytes))),
    );
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
   *
   * `param()` has already percent-decoded it, exactly once. Decoding again read
   * `docs/a%20b.md` as `docs/a b.md`, another file's text under this one's name, and made a
   * bare `%` a `URIError` (#608).
   */
  app.get('/v1/sources/:artifactId', async (context) =>
    answer(context, async () => {
      const artifactId = context.req.param('artifactId');
      const query = context.req.query();
      return options.runtime.readSource({
        artifactId,
        ...numeric('page', query.page),
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

/**
 * Whether a browser page's `Origin` names exactly the host and port this request was sent to.
 *
 * That is what "served by this server" means once `Host` has been checked against the
 * allowlist. Compared as `host:port` after URL normalisation, so `LOCALHOST:4321` and
 * `localhost:4321` agree and `http://localhost` and `localhost:80` do too.
 */
function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (host === undefined || hostnameOf(host) === undefined) return false;
  try {
    const page = new URL(origin);
    if (page.protocol !== 'http:' && page.protocol !== 'https:') return false;
    return page.host === new URL(`${page.protocol}//${host}`).host;
  } catch {
    return false;
  }
}

/**
 * The hostname a `Host` header names, lowercased, with an IPv6 literal kept in brackets.
 *
 * Parsed by the URL parser rather than split on a colon, so `[::1]:4321` keeps its brackets
 * and case and trailing ports are normalised the way a client resolved them. Anything that is
 * not a bare `host[:port]`, such as `127.0.0.1@evil.example`, is `undefined` and so refused.
 */
function hostnameOf(host: string): string | undefined {
  if (host === '' || /[/?#\\\s]/.test(host)) return undefined;
  try {
    const url = new URL(`http://${host}`);
    if (url.username !== '' || url.password !== '') return undefined;
    return url.hostname;
  } catch {
    return undefined;
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
  // Before the body is read. `text/plain`, a form encoding and no type at all are what a page
  // can send cross-origin without a CORS preflight; requiring JSON forces the preflight, and
  // this server never approves one for a foreign origin (#548).
  const type = context.req.header('Content-Type');
  if (!isJsonMediaType(type)) {
    throw new UnsupportedMediaTypeError(
      'LORE_E_INVALID_ARGUMENT',
      'This route takes a JSON body, sent as application/json.',
      {
        remediation: "Send the body with the header 'Content-Type: application/json'.",
        subject: type ?? '(none)',
      },
    );
  }

  // The `bodyLimit` middleware has already stopped a body that streamed past the cap. This
  // catches the one it trusts: a `Content-Length` smaller than the body, which an HTTP parser
  // never delivers but an in-process `Request` can carry.
  const text = await context.req.text();
  if (byteLength(text) > maxBytes) throw tooLarge(maxBytes);

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

  // Clipped, because both are the caller's own text: an unknown key is echoed into the
  // message, and a 200 KB key came back twice in every error (#551).
  const first = result.error.issues[0];
  const path = first === undefined ? '' : clip(first.path.join('.'));
  throw new LoreError(
    'LORE_E_INVALID_ARGUMENT',
    `The request body is invalid${path === '' ? '' : ` at \`${path}\``}: ${clip(first?.message ?? 'unknown reason')}.`,
    {
      remediation: 'Correct the named field and try again.',
      ...(path === '' ? {} : { subject: path }),
      details: {
        issues: result.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
          path: clip(issue.path.join('.')),
          message: clip(issue.message),
        })),
      },
    },
  );
}

/** Enough issues to fix a body by, and a bound on how many a caller can make us render. */
const MAX_REPORTED_ISSUES = 20;
const MAX_ECHOED_CHARACTERS = 256;

/** Caller-supplied text, shortened to what an error message needs to point at it. */
function clip(text: string): string {
  return text.length <= MAX_ECHOED_CHARACTERS
    ? text
    : `${text.slice(0, MAX_ECHOED_CHARACTERS)}... (${text.length} characters)`;
}

/** The media type before any parameter, so `application/json; charset=utf-8` qualifies. */
function isJsonMediaType(header: string | undefined): boolean {
  return header?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/** A request whose body is the wrong media type, answered as `415` rather than `400`. */
class UnsupportedMediaTypeError extends LoreError {}

function tooLarge(limit: number): LoreError {
  return new LoreError('LORE_E_LIMIT_EXCEEDED', 'The request body is too large.', {
    remediation: `This API accepts a body of at most ${limit} bytes.`,
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
  if (error instanceof UnsupportedMediaTypeError) return 415;
  const code = LoreError.from(error).code;
  if (code === 'LORE_E_BUILD_NOT_FOUND') return 404;
  if (code === 'LORE_E_INVALID_ARGUMENT') return 400;
  if (code === 'LORE_E_LIMIT_EXCEEDED') return 413;
  if (code === 'LORE_E_BUSY') return 429;
  if (code === 'LORE_E_SQL_REJECTED') return 400;
  if (code === 'LORE_E_INTERNAL') return 500;
  return 500;
}

function numeric(
  name: 'page' | 'lineStart' | 'lineEnd',
  raw: string | undefined,
): Record<string, number> {
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `${name} must be a positive whole number.`, {
      remediation: `Pass ${name} as a positive whole number, for example ${name}=12.`,
      subject: raw,
    });
  }
  return { [name]: value };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

async function validateMcpHeaders(request: Request): Promise<Response | null> {
  if (request.method.toUpperCase() !== 'POST') return null;
  const methodHeader = request.headers.get('Mcp-Method');
  const nameHeader = request.headers.get('Mcp-Name');
  if (methodHeader === null && nameHeader === null) return null;

  let parsed: unknown;
  try {
    parsed = await request.clone().json();
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) return null;
  const method = typeof parsed.method === 'string' ? parsed.method : undefined;
  if (method === undefined) return null;

  if (methodHeader === null) {
    return mcpHeaderMismatch(
      parsed,
      '(missing)',
      `the body names method ${method} but the required Mcp-Method header is absent`,
    );
  }
  if (methodHeader !== method) {
    return mcpHeaderMismatch(
      parsed,
      methodHeader,
      `the body names method ${method} but the Mcp-Method header names ${methodHeader}`,
    );
  }

  const sourceField = MCP_NAME_HEADER_SOURCE[method];
  if (sourceField === undefined) return null;

  const params = isPlainObject(parsed.params) ? parsed.params : null;
  const bodyValue = typeof params?.[sourceField] === 'string' ? params[sourceField] : undefined;
  if (bodyValue === undefined) return null;

  if (nameHeader === null) {
    return mcpHeaderMismatch(
      parsed,
      '(missing)',
      `the body carries params.${sourceField}=${JSON.stringify(bodyValue)} but the required Mcp-Name header is absent`,
    );
  }

  const decodedName = decodeMcpNameHeader(nameHeader);
  if (decodedName === undefined) {
    return mcpHeaderMismatch(
      parsed,
      nameHeader,
      'the Mcp-Name header carries an invalid Base64 sentinel value',
    );
  }
  if (decodedName !== bodyValue) {
    return mcpHeaderMismatch(
      parsed,
      nameHeader,
      `the body carries params.${sourceField}=${JSON.stringify(bodyValue)} but the Mcp-Name header names ${JSON.stringify(decodedName)}`,
    );
  }

  return null;
}

function mcpHeaderMismatch(
  parsed: Record<string, unknown>,
  header: string,
  detail: string,
): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      error: {
        code: HEADER_MISMATCH_ERROR_CODE,
        message: `Bad Request: the request headers and body disagree: ${detail}`,
        data: {
          mismatch: {
            header,
            body: detail,
          },
        },
      },
      id: echoableJsonRpcId(parsed),
    },
    {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function echoableJsonRpcId(parsed: Record<string, unknown>): string | number | null {
  const value = parsed.id;
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function decodeMcpNameHeader(raw: string): string | undefined {
  const trimmed = raw.trim();
  const encoded = /^=\?base64\?([A-Za-z0-9+/=]+)\?=$/i.exec(trimmed);
  if (encoded === null) return trimmed;
  try {
    const binary = atob(encoded[1] ?? '');
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
