import type { BuildComparer, LoreRuntime } from '@lorepack/core';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from './server.js';

/**
 * The MCP surface over Streamable HTTP, for mounting beside the REST routes.
 *
 * The core is still `createMcpHandler`, because the protocol requirement is unchanged: a
 * fresh server per request, no session state, and activation observed at the next request.
 * What changed in Phase 6 is the mounting layer: the mounted `/mcp` route now goes through
 * the official Hono adapter so local and Worker HTTP serving use the same framework-shaped
 * integration, not parallel hand wiring.
 *
 * The tool and resource surface comes from the same `createMcpServer` the stdio transport
 * uses. Two registrations would be two surfaces, and a client would have to know which
 * transport it was talking to.
 */
export function createMcpHttpHandler(
  runtime: LoreRuntime,
  comparer?: BuildComparer,
): McpHttpHandler {
  const handler = createMcpHandler(() =>
    createMcpServer({ runtime, ...(comparer === undefined ? {} : { comparer }) }),
  );
  const app = createMcpHonoApp({ host: '0.0.0.0' });
  app.all('/mcp', (context) => {
    const parsedBody = (context.get as (key: string) => unknown)('parsedBody');
    return handler.fetch(context.req.raw, { parsedBody });
  });

  return {
    ...handler,
    fetch: async (request, options) => {
      if (options?.authInfo !== undefined || options?.parsedBody !== undefined) {
        return handler.fetch(request, options);
      }
      return await app.fetch(request);
    },
  };
}
