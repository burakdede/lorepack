/**
 * One request, written the three ways a developer can make it outside Studio.
 *
 * Studio, the `lore` CLI, the HTTP API and the MCP tools are four doors into one runtime, and
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
}

export function contextEquivalents(request: ContextRequest, origin: string): Equivalents {
  const cli = ['lore export', `--task ${shellQuote(request.task)}`, `--profile ${request.profile}`];
  if (request.budget !== undefined) cli.push(`--budget ${request.budget}`);
  return {
    cli: cli.join(' '),
    http: curlPost(origin, '/v1/context', request),
    mcp: { name: 'lore_context_for_task', arguments: { ...request } },
  };
}

export interface SearchRequest {
  readonly query: string;
  readonly debug?: boolean;
}

export function searchEquivalents(request: SearchRequest, origin: string): Equivalents {
  return {
    cli: `lore search ${shellQuote(request.query)}${request.debug === true ? ' --debug' : ''}`,
    http: curlPost(origin, '/v1/search', request),
    mcp: { name: 'lore_search', arguments: { ...request } },
  };
}

/** The CLI has no SQL command, so a table query has no CLI rendering. */
export function tableQueryEquivalents(tableId: string, sql: string, origin: string): Equivalents {
  return {
    http: curlPost(origin, `/v1/tables/${encodeURIComponent(tableId)}/query`, { sql }),
    mcp: { name: 'lore_query_table', arguments: { tableId, sql } },
  };
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * No CLI rendering: `lore inspect <path>` prints a source's metadata and structure, not the
 * stored text, so offering it here would be an approximation passed off as an equivalent.
 */
export function readSourceEquivalents(
  artifactId: string,
  range: LineRange | null,
  origin: string,
): Equivalents {
  const query = range === null ? '' : `?lineStart=${range.start}&lineEnd=${range.end}`;
  return {
    http: `curl -s ${shellQuote(`${origin}/v1/sources/${encodeURIComponent(artifactId)}${query}`)}`,
    mcp: {
      name: 'lore_read_source',
      arguments:
        range === null
          ? { artifactId }
          : { artifactId, lineStart: range.start, lineEnd: range.end },
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
