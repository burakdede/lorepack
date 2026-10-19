/**
 * One request, written the three ways a developer can make it outside Studio.
 *
 * Studio, the `lorepack` CLI, the HTTP API and the MCP tools are four doors into one runtime, and
 * the request bodies are the same schemas behind each (`searchRequestSchema`,
 * `taskContextRequestSchema`, `sourceReadRequestSchema`, `tableQueryRequestSchema` in
 * `@lorepack/core`). So a request tried here can be carried into a terminal, a script or an
 * agent without retyping it, and each rendering is built from the exact object Studio sent.
 *
 * The CLI line is POSIX shell. Arguments are single-quoted, so nothing in a task or a query
 * is expanded by the shell it is pasted into.
 */

export interface McpCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface Equivalents {
  /** Absent when the CLI has no command for this request, rather than an approximate one. */
  readonly cli?: string;
  readonly http: string;
  readonly mcp: McpCall;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function curlPost(origin: string, path: string, body: unknown): string {
  return [
    `curl -s -X POST ${origin}${path}`,
    `  -H 'content-type: application/json'`,
    `  -d ${shellQuote(JSON.stringify(body))}`,
  ].join(' \\\n');
}

export interface ContextRequest {
  readonly task: string;
  readonly profile: string;
  readonly budget?: number;
  readonly receipt?: { readonly captureRequest: boolean };
}

export function contextEquivalents(request: ContextRequest, origin: string): Equivalents {
  const cli = [
    'lorepack export',
    `--task ${shellQuote(request.task)}`,
    `--profile ${request.profile}`,
  ];
  if (request.budget !== undefined) cli.push(`--budget ${request.budget}`);
  if (request.receipt !== undefined) {
    cli.push('--format json --output context.json --receipt context-receipt.json');
    if (request.receipt.captureRequest) cli.push('--capture-request');
  }
  return {
    cli: cli.join(' '),
    http:
      request.receipt === undefined
        ? curlPost(origin, '/v1/context', request)
        : curlPost(origin, '/v1/context', request).replace(
            'curl -s ',
            'curl -s --output context.json --dump-header context.headers ',
          ),
    mcp: { name: 'lore_context_for_task', arguments: { ...request } },
  };
}

export interface SearchRequest {
  readonly query: string;
  readonly debug?: boolean;
}

export function searchEquivalents(request: SearchRequest, origin: string): Equivalents {
  return {
    cli: `lorepack search ${shellQuote(request.query)}${request.debug === true ? ' --debug' : ''}`,
    http: curlPost(origin, '/v1/search', request),
    mcp: { name: 'lore_search', arguments: { ...request } },
  };
}

/** The CLI has no SQL command, so a table query has no CLI rendering. */
export function tableQueryEquivalents(
  tableId: string,
  sql: string,
  origin: string,
  buildId?: string,
): Equivalents {
  return {
    http: curlPost(origin, `/v1/tables/${encodeURIComponent(tableId)}/query`, {
      sql,
      ...(buildId === undefined ? {} : { buildId }),
    }),
    mcp: {
      name: 'lore_query_table',
      arguments: { tableId, sql, ...(buildId === undefined ? {} : { buildId }) },
    },
  };
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * No CLI rendering: `lorepack inspect <path>` prints a source's metadata and structure, not the
 * stored text, so offering it here would be an approximation passed off as an equivalent.
 */
export function readSourceEquivalents(
  artifactId: string,
  range: LineRange | null,
  origin: string,
  buildId?: string,
): Equivalents {
  const params = new URLSearchParams();
  if (range !== null) {
    params.set('lineStart', String(range.start));
    params.set('lineEnd', String(range.end));
  }
  if (buildId !== undefined) params.set('buildId', buildId);
  const query = params.size === 0 ? '' : `?${params}`;
  return {
    http: `curl -s ${shellQuote(`${origin}/v1/sources/${encodeURIComponent(artifactId)}${query}`)}`,
    mcp: {
      name: 'lore_read_source',
      arguments:
        range === null
          ? { artifactId, ...(buildId === undefined ? {} : { buildId }) }
          : {
              artifactId,
              lineStart: range.start,
              lineEnd: range.end,
              ...(buildId === undefined ? {} : { buildId }),
            },
    },
  };
}

/** The `tools/call` params an MCP client sends, which is what a developer pastes. */
export function formatMcp(call: McpCall): string {
  return JSON.stringify({ name: call.name, arguments: call.arguments }, null, 2);
}

/** The origin Studio was served from, which is the API's and the MCP endpoint's too. */
export function serverOrigin(): string {
  return typeof window === 'undefined' ? 'http://127.0.0.1:43110' : window.location.origin;
}
