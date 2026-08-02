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
  /** Largest request body accepted, in bytes. */
  readonly maxRequestBytes?: number;
}

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
    if (origin !== undefined && !allowed.has(origin) && context.req.path !== '/health') {
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

  app.get('/v1/build', (context) => answer(context, () => options.runtime.describeBuild()));

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
