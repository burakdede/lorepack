import { type BuildComparer, LoreError, type LoreRuntime } from '@lorepack/core';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  INVALID_PARAMS,
  ProtocolError,
  ResourceNotFoundError,
  ResourceTemplate,
} from '@modelcontextprotocol/server';

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

/**
 * Whose fault a failed read was, in the code the protocol reserves for it.
 *
 * An uncaught throw becomes `-32603` INTERNAL_ERROR, which tells the client the *server*
 * broke. For a URI naming a document that is not in the build, that is simply untrue, and it
 * is the difference between an agent fixing its URI and an agent giving up (#191). REST has
 * always classified this correctly, through `statusFor()` in the runtime's HTTP app; this is
 * the same judgement, expressed in the other surface's vocabulary.
 *
 * Anything unrecognized is rethrown untouched, because `-32603` is the right answer when the
 * server really did break, and narrowing it must not mean deleting it.
 */
function classify(uri: URL, cause: unknown): unknown {
  const failure = LoreError.from(cause);
  const remediation = failure.remediation === undefined ? '' : ` ${failure.remediation}`;
  const message = `${failure.message}${remediation}`;

  switch (failure.code) {
    // Covers both "no such document" and "no such build", and the deployment that holds one
    // build and cannot compare two. The protocol has one code for "this server cannot
    // produce that resource", so the three are told apart by message and remediation rather
    // than by inventing an implementation-defined code no client would recognize.
    case 'LORE_E_BUILD_NOT_FOUND':
      return new ResourceNotFoundError(uri.href, message);
    case 'LORE_E_INVALID_ARGUMENT':
      return new ProtocolError(INVALID_PARAMS, message);
    default:
      return cause;
  }
}

/** Wraps a resource read so every handler classifies failures the same way. */
async function read<T>(uri: URL, produce: () => Promise<T>): Promise<T> {
  try {
    return await produce();
  } catch (cause) {
    throw classify(uri, cause);
  }
}

export const RESOURCE_URIS = [
  'lore://project/build',
  'lore://project/sources',
  'lore://project/tables',
] as const;

/** Templates, which take a variable and so cannot be listed as fixed URIs. */
export const RESOURCE_TEMPLATES = [
  'lore://source/{artifactId}',
  'lore://build/{buildId}/diff/{otherBuildId}',
] as const;

export interface ResourceOptions {
  /**
   * Reaches build history, for the diff resource.
   *
   * Optional because it is not part of `LoreRuntime`: a diff reads two builds, neither of
   * which need be active, and a deployment that holds only the build it serves genuinely
   * cannot answer. The resource is registered either way, and says which case it is in
   * rather than disappearing from the listing.
   */
  readonly comparer?: BuildComparer;
}

export function registerResources(
  server: McpServer,
  runtime: LoreRuntime,
  options: ResourceOptions = {},
): void {
  server.registerResource(
    'build',
    'lore://project/build',
    {
      title: 'Active build',
      description: 'What the active build contains, and whether the sources have moved on.',
      mimeType: 'application/json',
    },
    async (uri) =>
      read(uri, async () => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(await runtime.describeBuild(), null, 2),
          },
        ],
      })),
  );

  server.registerResource(
    'sources',
    'lore://project/sources',
    {
      title: 'What this build indexed',
      description:
        'How much this build contains, and whether the sources have moved on since. Not a document listing: use lore_search to find a document, and lore_read_source to read one.',
      mimeType: 'application/json',
    },
    async (uri) =>
      read(uri, async () => {
        // Counts, deliberately, because no capability can enumerate artifacts: `LoreRuntime`
        // is seven capabilities (architecture 13.1) and none of them lists a build's
        // documents. This said "every document, with its path and status" until #193, which
        // is the product claiming something it cannot do, to the one reader that believes it.
        //
        // The listing is a real gap rather than a decision, and #66 (Studio's Sources route)
        // is where it has to be built. Today the only implementation is raw SQL inside
        // `lore inspect sources`, which no remote backend can reach.
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
                  note: 'This interface cannot list the documents in a build. Use lore_search to find one, then lore_read_source to read it.',
                },
                null,
                2,
              ),
            },
          ],
        };
      }),
  );

  server.registerResource(
    'tables',
    'lore://project/tables',
    {
      title: 'Typed tables',
      description: 'Tables in the active build. Empty for a build compiled from documents alone.',
      mimeType: 'application/json',
    },
    async (uri) =>
      read(uri, async () => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ tables: await runtime.listTables() }, null, 2),
          },
        ],
      })),
  );

  server.registerResource(
    'source',
    new ResourceTemplate('lore://source/{artifactId}', { list: undefined }),
    {
      title: 'One source document',
      description: 'The normalized text of one document, with its locator.',
      mimeType: 'application/json',
    },
    async (uri, variables) =>
      read(uri, async () => {
        const artifactId = decodeURIComponent(String(variables.artifactId));
        const result = await runtime.readSource({ artifactId });
        return {
          contents: [
            { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result, null, 2) },
          ],
        };
      }),
  );

  server.registerResource(
    'diff',
    new ResourceTemplate('lore://build/{buildId}/diff/{otherBuildId}', { list: undefined }),
    {
      title: 'What changed between two builds',
      description:
        'The difference between two builds: documents added, removed and changed, and whether the change is compatible. Computed from build records alone, so it works after the sources have moved on.',
      mimeType: 'application/json',
    },
    async (uri, variables) =>
      read(uri, async () => {
        const comparer = options.comparer;
        if (comparer === undefined) {
          throw new LoreError(
            'LORE_E_BUILD_NOT_FOUND',
            'This deployment serves one build and cannot compare two.',
            {
              remediation:
                'Run `lore diff` against the project, or point a client at a server that holds build history.',
            },
          );
        }

        const from = decodeURIComponent(String(variables.buildId));
        const to = decodeURIComponent(String(variables.otherBuildId));
        const diff = await comparer.compare(from, to);
        return {
          contents: [
            { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(diff, null, 2) },
          ],
        };
      }),
  );
}
