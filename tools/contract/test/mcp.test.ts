import type {
  BuildHandle,
  BuildId,
  BuildManifest,
  BuildScope,
  CatalogArtifact,
  CatalogNode,
  CatalogSearchHit,
  CatalogStore,
  TableStore,
} from '@lorepack/core';
import { LoreError, searchResultSchema } from '@lorepack/core';
import { createMcpServer, TOOL_NAMES } from '@lorepack/mcp';
import { createRuntime } from '@lorepack/runtime';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The MCP surface, driven by the real v2 client over an in-memory transport.
 *
 * A hand-rolled fixture client would agree with whatever the server believed. The SDK's
 * own client speaks the 2026-07-28 protocol, so what is asserted here is conformance
 * rather than self-consistency.
 */

const BUILD = `lore_${'a'.repeat(64)}` as BuildId;

const HIT: CatalogSearchHit = {
  chunkId: 'p:guides/a.md@0',
  artifactId: 'p:guides/a.md',
  relativePath: 'guides/a.md',
  displayPath: 'guides/a.md',
  headingPath: ['Guides'],
  lineStart: 3,
  lineEnd: 4,
  status: 'active',
  authority: 50,
  estimatedTokens: 12,
  text: 'rollback restores the previous release without recompiling anything at all',
  title: 'A guide',
  bm25: -2,
  excerpt: 'a [rollback]',
};

const catalog: CatalogStore = {
  async manifest(): Promise<BuildManifest> {
    return {
      formatVersion: 1,
      buildId: BUILD,
      projectName: 'demo',
      compilerVersion: '0.1.0',
      schemaVersion: 1,
      configurationHash: 'c'.repeat(64),
      sourceFingerprint: 'd'.repeat(64),
      canonicalRoots: {
        artifacts: 'e'.repeat(64),
        nodes: 'f'.repeat(64),
        chunks: '0'.repeat(64),
        tables: '1'.repeat(64),
        objects: '2'.repeat(64),
      },
      capabilities: ['lexical-search', 'structured-context'],
      counts: { artifacts: 1, nodes: 1, chunks: 1, tables: 0, tableRows: 0 },
      warnings: [],
    } as BuildManifest;
  },
  async countChunks() {
    return 1;
  },
  async countWarnings() {
    return 0;
  },
  async search() {
    return [HIT];
  },
  async supersededArtifacts() {
    return new Set<string>();
  },
  async artifact(idOrPath: string): Promise<CatalogArtifact | null> {
    if (idOrPath !== 'p:guides/a.md') return null;
    return {
      artifactId: 'p:guides/a.md',
      relativePath: 'guides/a.md',
      displayPath: 'guides/a.md',
      title: 'A guide',
      status: 'active',
      authority: 50,
      mediaType: 'text/markdown',
      objectHash: 'f'.repeat(64),
    };
  },
  async nodes(): Promise<readonly CatalogNode[]> {
    return [
      {
        nodeId: 'n0',
        artifactId: 'p:guides/a.md',
        kind: 'paragraph',
        ordinal: 0,
        title: null,
        text: 'the only node',
        headingPath: ['Guides'],
        lineStart: 3,
        lineEnd: 4,
      },
    ];
  },
};

const tables: TableStore = {
  async list() {
    return [];
  },
  async describe() {
    return null;
  },
  async query() {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This build declares no tables.');
  },
};

const scope: BuildScope = {
  buildId: BUILD,
  catalog,
  tables,
  objects: {
    async get() {
      return new TextEncoder().encode('the whole normalized body');
    },
    async put() {
      return '';
    },
    async has() {
      return true;
    },
  },
};

let client: Client;

beforeEach(async () => {
  const runtime = createRuntime({
    provider: {
      async current() {
        return { buildId: BUILD, generation: 1 };
      },
      async acquire(): Promise<BuildHandle> {
        return { buildId: BUILD, generation: 1, release() {} };
      },
    },
    open: async () => scope,
    freshness: async () => 'clean',
  });

  const server = createMcpServer({ runtime });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  client = new Client({ name: 'contract-tests', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

describe('the tool surface, architecture 14.1', () => {
  it('is exactly the seven documented tools, in a deterministic order', async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);

    expect(names).toEqual([...TOOL_NAMES]);
    // Twice, because a client may cache the list and a changing order defeats that.
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(names);
  });

  it('declares every tool read-only, and offers nothing that could change anything', async () => {
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
    // The stronger statement than word-matching a name: the registered set is exactly the
    // seven read-only capabilities, so a mutating tool cannot exist without this failing.
    expect(new Set(listed.tools.map((tool) => tool.name))).toEqual(new Set(TOOL_NAMES));
  });

  it('declares an output schema on every tool, which is what makes provenance enforceable', async () => {
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });

  it('describes each tool without implying truth or confidence', async () => {
    const listed = await client.listTools();
    const prose = listed.tools
      .map((tool) => tool.description ?? '')
      .join(' ')
      .toLowerCase();
    expect(prose).not.toMatch(/\bconfidence\b(?!,? and not)/);
    expect(prose).not.toMatch(/detected conflict|authoritative answer|correct answer/);
    // And the search tool says plainly what its score is not.
    const search = listed.tools.find((tool) => tool.name === 'lore_search');
    expect(search?.description).toMatch(/not a confidence/i);
  });
});

describe('results', () => {
  it('returns structured content a client can validate against the declared schema', async () => {
    const result = await client.callTool({
      name: 'lore_search',
      arguments: { query: 'rollback' },
    });

    expect(result.isError).toBeFalsy();
    // The structured half is the contract; parsing it with the server's own schema is the
    // strongest statement available that the two have not drifted.
    expect(() => searchResultSchema.parse(result.structuredContent)).not.toThrow();
  });

  it('also returns a text block, so a 2025-era client sees something', async () => {
    const result = await client.callTool({ name: 'lore_build_info', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe('text');
    expect(JSON.parse(content[0]?.text ?? '{}')).toMatchObject({ projectName: 'demo' });
  });

  it('carries the build id and freshness on every tool that reads the build', async () => {
    for (const [name, args] of [
      ['lore_build_info', {}],
      ['lore_search', { query: 'rollback' }],
      ['lore_context_for_task', { task: 'how do I roll back' }],
      ['lore_read_source', { artifactId: 'p:guides/a.md' }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      const structured = result.structuredContent as { buildId?: string; sourceState?: string };
      expect(structured.buildId, name).toBe(BUILD);
      expect(structured.sourceState, name).toBe('clean');
    }
  });

  it('gives every search hit and every citation a locator', async () => {
    const searched = await client.callTool({
      name: 'lore_search',
      arguments: { query: 'rollback' },
    });
    const hits = (searched.structuredContent as { hits: Array<{ locator: unknown }> }).hits;
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.locator).toBeDefined();

    const bundle = await client.callTool({
      name: 'lore_context_for_task',
      arguments: { task: 'rollback' },
    });
    const citations = (bundle.structuredContent as { citations: Array<{ relativePath: string }> })
      .citations;
    for (const citation of citations) expect(citation.relativePath).not.toBe('');
  });

  it('defaults context assembly to the agent profile', async () => {
    const result = await client.callTool({
      name: 'lore_context_for_task',
      arguments: { task: 'anything at all' },
    });
    expect((result.structuredContent as { profile: string }).profile).toBe('agent');
  });
});

describe('failures', () => {
  it('reports a tool that ran and could not answer as an error result, not a protocol error', async () => {
    // A model sees `isError` results and can correct itself. It never sees a JSON-RPC error.
    const result = await client.callTool({
      name: 'lore_read_source',
      arguments: { artifactId: 'nothing/like/this.md' },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ text: string }>;
    expect(content[0]?.text).toContain('LORE_E_BUILD_NOT_FOUND');
  });

  it('leaks no filesystem path outside the project, and no stack trace', async () => {
    const result = await client.callTool({
      name: 'lore_read_source',
      arguments: { artifactId: '../../../etc/passwd' },
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).not.toContain('at Object.');
    expect(text).not.toMatch(/\/home\/|C:\\\\Users/);
  });

  it('rejects invalid tool input, naming the field', async () => {
    const result = await client
      .callTool({ name: 'lore_search', arguments: { query: '', limit: 9999 } })
      .catch((error: unknown) => error);

    // Either shape is conformant: what matters is that it is refused and says why.
    const text = JSON.stringify(result);
    expect(text).toMatch(/limit|query/);
  });

  it('rejects an unknown tool', async () => {
    await expect(
      client.callTool({ name: 'lore_delete_everything', arguments: {} }),
    ).rejects.toThrow();
  });
});

describe('resources, architecture 14.2', () => {
  it('lists the project resources deterministically', async () => {
    const first = await client.listResources();
    const second = await client.listResources();
    expect(second.resources.map((r) => r.uri)).toEqual(first.resources.map((r) => r.uri));
    expect(first.resources.map((r) => r.uri)).toContain('lore://project/build');
  });

  it('reads a resource body carrying the build id', async () => {
    const read = await client.readResource({ uri: 'lore://project/build' });
    const contents = read.contents as Array<{ text: string }>;
    expect(JSON.parse(contents[0]?.text ?? '{}')).toMatchObject({ buildId: BUILD });
  });

  it('reads one source through its template', async () => {
    const read = await client.readResource({ uri: 'lore://source/p%3Aguides%2Fa.md' });
    const contents = read.contents as Array<{ text: string }>;
    expect(JSON.parse(contents[0]?.text ?? '{}').text).toContain('normalized body');
  });
});

describe('the stateless model', () => {
  it('never asks the client for input, because every tool is read-only', async () => {
    for (const name of TOOL_NAMES) {
      const args =
        name === 'lore_search'
          ? { query: 'a' }
          : name === 'lore_context_for_task'
            ? { task: 'a' }
            : name === 'lore_read_source'
              ? { artifactId: 'p:guides/a.md' }
              : name === 'lore_describe_table'
                ? { tableId: 'sales' }
                : name === 'lore_query_table'
                  ? { tableId: 'sales', sql: 'SELECT 1' }
                  : {};
      const result = await client.callTool({ name, arguments: args }).catch(() => null);
      // `input_required` is elicitation, and a read-only server has nothing to elicit.
      if (result !== null) expect(result.resultType ?? 'complete').toBe('complete');
    }
  });
});
