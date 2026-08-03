import type { BuildComparer, LoreRuntime } from '@lorepack/core';
import { McpServer } from '@modelcontextprotocol/server';
import { LEGACY_HANDSHAKE_VERSIONS, MCP_PROTOCOL_VERSION } from './protocol.js';
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
  /** Reaches build history, for the `lore://build/{buildId}/diff/{otherBuildId}` resource. */
  readonly comparer?: BuildComparer;
}

export const SERVER_NAME = 'lorepack';

/**
 * The revisions this server answers, newest first.
 *
 * Declaring this is not optional decoration. The SDK installs the mandatory
 * `server/discover` handler only when the list contains a 2026-era entry, and its default
 * is the legacy handshake list, so a server that says nothing is silently legacy-only. The
 * HTTP handler papered over that by appending the version it served, which left `lore mcp`
 * on stdio answering `Method not found` to the one probe a modern client is told to send
 * (#189).
 *
 * The legacy entries stay because 2026-07-28 requires a server to keep serving 2025-era
 * clients through `initialize`. They are only ever reached through that handshake: the
 * modern era is selected exclusively via `server/discover`.
 */
const SUPPORTED_VERSIONS = [MCP_PROTOCOL_VERSION, ...LEGACY_HANDSHAKE_VERSIONS];

export function createMcpServer(options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version ?? '0.1.0' },
    {
      supportedProtocolVersions: [...SUPPORTED_VERSIONS],
      instructions:
        'Lorepack serves a versioned, immutable build of this project documentation. Call lore_build_info first to see what the build contains, then lore_context_for_task for a bounded cited bundle, or lore_search for specific passages. Every result names the file, heading and lines it came from, and the build id it was read from. Lorepack never decides which of two documents is correct.',
    },
  );

  registerTools(server, options.runtime);
  registerResources(server, options.runtime, {
    ...(options.comparer === undefined ? {} : { comparer: options.comparer }),
  });
  return server;
}
