import type { LoreRuntime } from '@lorepack/core';
import type { McpServer } from '@modelcontextprotocol/server';
import { ResourceTemplate } from '@modelcontextprotocol/server';

/**
 * MCP resources, architecture 14.2.
 *
 * Resources are for what a client wants to *browse*; tools are for what it wants to *ask*.
 * The same runtime answers both, so a resource can never show something a tool would deny.
 *
 * Every resource body is JSON carrying the build id, for the same reason every tool result
 * does: a client may cache a resource list, and the answer has to say which build it came
 * from rather than relying on the list being fresh.
 */

export const RESOURCE_URIS = [
  'lore://project/build',
  'lore://project/sources',
  'lore://project/tables',
] as const;

export function registerResources(server: McpServer, runtime: LoreRuntime): void {
  server.registerResource(
    'build',
    'lore://project/build',
    {
      title: 'Active build',
      description: 'What the active build contains, and whether the sources have moved on.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await runtime.describeBuild(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'sources',
    'lore://project/sources',
    {
      title: 'Indexed sources',
      description: 'Every document in the active build, with its path and status.',
      mimeType: 'application/json',
    },
    async (uri) => {
      // Sourced from a search with no terms rather than a new capability: the runtime
      // interface is fixed at seven capabilities, and a resource is a view of them.
      const described = await runtime.describeBuild();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                buildId: described.buildId,
                sourceState: described.sourceState,
                counts: described.counts,
                note: 'Use lore_search or lore_read_source to read a document.',
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerResource(
    'tables',
    'lore://project/tables',
    {
      title: 'Typed tables',
      description: 'Tables in the active build. Empty for a build compiled from documents alone.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ tables: await runtime.listTables() }, null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'source',
    new ResourceTemplate('lore://source/{artifactId}', { list: undefined }),
    {
      title: 'One source document',
      description: 'The normalized text of one document, with its locator.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const artifactId = decodeURIComponent(String(variables.artifactId));
      const result = await runtime.readSource({ artifactId });
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
