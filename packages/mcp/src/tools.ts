import {
  buildDescriptionSchema,
  buildSelectionSchema,
  contextBundleSchema,
  createContextReceipt,
  forClient,
  type LoreRuntime,
  searchRequestSchema,
  searchResultSchema,
  sourceListRequestSchema,
  sourceListResultSchema,
  sourceReadRequestSchema,
  sourceReadResultSchema,
  tableDescriptionSchema,
  tableListResultSchema,
  tableQueryRequestSchema,
  tableQueryResultSchema,
  taskContextRequestSchema,
} from '@lorepack/core/worker';
import { toolResult as reply } from '@lorepack/runtime';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/**
 * The MCP tool surface includes the shared read-only build capabilities.
 *
 * **Every tool declares an `outputSchema` built from the same Zod contract the REST API
 * uses.** That is the significant upgrade the 2026-07-28 specification allows: provenance
 * stops being a convention our tests enforce and becomes a schema the client validates. A
 * result without a locator is then a protocol violation rather than a style problem.
 *
 * Read-only, all of them (architecture 19.4). There is no build, deploy, edit or shell
 * tool, and a test enumerates the registered surface to keep it that way.
 */

/** Tools that read a build and change nothing, which is all of them. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

export const TOOL_NAMES = [
  'lore_build_info',
  'lore_search',
  'lore_context_for_task',
  'lore_list_sources',
  'lore_read_source',
  'lore_list_tables',
  'lore_describe_table',
  'lore_query_table',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function registerTools(server: McpServer, runtime: LoreRuntime): void {
  server.registerTool(
    'lore_build_info',
    {
      title: 'Describe the active context build',
      description:
        'Report which build is active, what it contains, and whether the sources have changed since it was compiled. Call this first to learn what corpus you are reading.',
      inputSchema: buildSelectionSchema,
      outputSchema: buildDescriptionSchema,
      annotations: READ_ONLY,
    },
    async (selection) => guard(async () => reply(await runtime.describeBuild(selection))),
  );

  server.registerTool(
    'lore_search',
    {
      title: 'Search the build',
      description:
        'Find passages matching a keyword query. Every result carries the file, heading path and line range it came from. Relevance is a heuristic about matching words, not a confidence and not evidence the content is correct.',
      inputSchema: searchRequestSchema,
      outputSchema: searchResultSchema,
      annotations: READ_ONLY,
    },
    async (request) => guard(async () => reply(await runtime.search(request))),
  );

  server.registerTool(
    'lore_context_for_task',
    {
      title: 'Assemble context for a task',
      description:
        'Describe a task in your own words and receive a bounded, cited bundle of the passages most likely to matter, plus a complete list of what was left out and why. Defaults to the agent profile. Nothing in the bundle is generated: every passage is text from a document, with its location.',
      inputSchema: taskContextRequestSchema,
      outputSchema: contextBundleSchema,
      annotations: READ_ONLY,
    },
    async (request) =>
      guard(async () => {
        const bundle = await runtime.contextForTask(request);
        const result = reply(bundle);
        if (request.receipt === undefined || request.receipt === false) return result;
        const receipt = await createContextReceipt({
          bundle,
          payload: JSON.stringify(result),
          format: 'mcp-content',
          captureRequest: typeof request.receipt === 'object' && request.receipt.captureRequest,
        });
        return { ...result, _meta: { 'lorepack.dev/context-receipt': receipt } };
      }),
  );

  server.registerTool(
    'lore_list_sources',
    {
      title: 'List sources in a build',
      description:
        'List a bounded page of source documents with read locators. Continue with nextOffset and the returned buildId to keep all pages on the same immutable build.',
      inputSchema: sourceListRequestSchema,
      outputSchema: sourceListResultSchema,
      annotations: READ_ONLY,
    },
    async (request) => guard(async () => reply(await runtime.listSources(request))),
  );

  server.registerTool(
    'lore_read_source',
    {
      title: 'Read an exact source range',
      description:
        'Read a document, or a line or heading range within it, exactly as the build recorded it. The locator is echoed back in source coordinates so a citation points at the real file. Truncation, if any, is stated in the result.',
      inputSchema: sourceReadRequestSchema,
      outputSchema: sourceReadResultSchema,
      annotations: READ_ONLY,
    },
    async (request) => guard(async () => reply(await runtime.readSource(request))),
  );

  server.registerTool(
    'lore_list_tables',
    {
      title: 'List typed tables',
      description:
        'List the typed tables this build contains. A build compiled from documents alone has none, and says so rather than failing.',
      inputSchema: buildSelectionSchema,
      outputSchema: tableListResultSchema,
      annotations: READ_ONLY,
    },
    async (selection) => guard(async () => reply(await runtime.listTables(selection))),
  );

  server.registerTool(
    'lore_describe_table',
    {
      title: 'Describe a table',
      description:
        'Report a table its columns, types, per-column statistics, row count and a small sample, with the sheet and cell range it came from. Call this before writing SQL: it reports the `sqlName` of the table and of every column, which are the only names a query may use.',
      inputSchema: z.object({ ...buildSelectionSchema.shape, tableId: z.string().min(1) }).strict(),
      outputSchema: tableDescriptionSchema,
      annotations: READ_ONLY,
    },
    async ({ tableId, ...selection }) =>
      guard(async () => reply(await runtime.describeTable(tableId, selection))),
  );

  server.registerTool(
    'lore_query_table',
    {
      title: 'Query a table',
      description:
        'Run one read-only SELECT against a build-owned table, addressing it by the `sqlName` values `lore_describe_table` reports rather than by the names the source file used. Results carry the table and source provenance, and row and time limits apply.',
      inputSchema: tableQueryRequestSchema,
      outputSchema: tableQueryResultSchema,
      annotations: READ_ONLY,
    },
    async (request) => guard(async () => reply(await runtime.queryTable(request))),
  );
}

/**
 * Runs a capability and turns any failure into a result the model can read.
 *
 * Without this the SDK converts a thrown error into an error result carrying the message
 * alone, and the stable code, which is the part a client should branch on, never reaches
 * anyone. Wrapping every handler is cheap and keeps the two halves of the answer together.
 */
async function guard<T>(body: () => Promise<T>): Promise<T | ReturnType<typeof toolFailure>> {
  try {
    return await body();
  } catch (error) {
    return toolFailure(error);
  }
}

/**
 * Turns a failure into a tool result a model can act on.
 *
 * Architecture and the specification agree here: a tool that *ran* and could not do the
 * job returns `isError: true` with a sentence the model can use to correct itself, rather
 * than a protocol error, which the model never sees. A stack trace or a filesystem path
 * would be neither useful nor safe, so only the message and its remediation travel.
 */
export function toolFailure(error: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  // Unclassified failures, raw D1 or SQLite text among them, are replaced and logged rather
  // than shown to the model (#560).
  const { error: failure, hidden } = forClient(error);
  if (hidden !== undefined) console.error('lorepack: internal error in an MCP tool', hidden);
  const remediation = failure.remediation === undefined ? '' : ` ${failure.remediation}`;
  return {
    content: [{ type: 'text', text: `${failure.code}: ${failure.message}${remediation}` }],
    isError: true,
  };
}
