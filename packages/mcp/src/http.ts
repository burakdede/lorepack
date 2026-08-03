import type { BuildComparer, LoreRuntime } from '@lorepack/core';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from './server.js';

/**
 * The MCP surface over Streamable HTTP, for mounting beside the REST routes.
 *
 * `createMcpHandler` builds a fresh server per request from the factory, which is the
 * shape the 2026-07-28 specification asks for: there is no session to keep, so there is no
 * session state to lose, to leak between callers, or to go stale while a build changes
 * underneath it. Every request re-reads the active build through the runtime, so activation
 * is observed at the next request exactly as it is over stdio and over REST.
 *
 * The tool and resource surface comes from the same `createMcpServer` the stdio transport
 * uses. Two registrations would be two surfaces, and a client would have to know which
 * transport it was talking to.
 */
export function createMcpHttpHandler(
  runtime: LoreRuntime,
  comparer?: BuildComparer,
): McpHttpHandler {
  return createMcpHandler(() =>
    createMcpServer({ runtime, ...(comparer === undefined ? {} : { comparer }) }),
  );
}
