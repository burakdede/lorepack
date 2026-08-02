import type { LoreRuntime } from '@lorepack/core';
import { McpServer } from '@modelcontextprotocol/server';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

/**
 * The Lorepack MCP server, assembled from the tool and resource surfaces.
 *
 * Everything protocol-shaped lives in this package and nothing else imports the MCP SDK.
 * That isolation is architecture 8.6: the protocol is young and moving, and when it moves
 * again the change must not reach the compiler or the storage schema.
 *
 * Stateless by construction, which the 2026-07-28 specification requires. There is no
 * session, no cached capability list that could go stale, and no state that outlives a
 * request: every result carries the build it was read from, so a client that holds a
 * connection open for an hour still learns when the build underneath it changed.
 */

export interface ServerOptions {
  readonly runtime: LoreRuntime;
  readonly version?: string;
}

export const SERVER_NAME = 'lorepack';

export function createMcpServer(options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version ?? '0.1.0' },
    {
      instructions:
        'Lorepack serves a versioned, immutable build of this project documentation. Call lore_build_info first to see what the build contains, then lore_context_for_task for a bounded cited bundle, or lore_search for specific passages. Every result names the file, heading and lines it came from, and the build id it was read from. Lorepack never decides which of two documents is correct.',
    },
  );

  registerTools(server, options.runtime);
  registerResources(server, options.runtime);
  return server;
}
