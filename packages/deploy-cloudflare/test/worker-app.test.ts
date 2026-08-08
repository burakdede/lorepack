import type {
  BuildHandle,
  BuildId,
  BuildManifest,
  BuildScope,
  CatalogArtifact,
  CatalogNode,
  CatalogSearchCriteria,
  CatalogSearchHit,
  CatalogStore,
  TableStore,
} from '@lorepack/core';
import { createMcpHttpHandler, MCP_PROTOCOL_VERSION, TOOL_NAMES } from '@lorepack/mcp';
import { createApiApp, createRuntime } from '@lorepack/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { createCloudflareWorker } from '../src/index.js';

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
  text: 'a rollback restores the previous release without recompiling',
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
      counts: { artifacts: 1, nodes: 2, chunks: 1, tables: 0, tableRows: 0 },
      warnings: [],
    } as BuildManifest;
  },
  async countChunks() {
    return 1;
  },
  async countWarnings() {
    return 0;
  },
  async search(_query: string, criteria: CatalogSearchCriteria) {
    return [HIT].slice(0, criteria.limit);
  },
  async supersededArtifacts() {
    return new Set<string>();
  },
  async artifact(idOrPath: string): Promise<CatalogArtifact | null> {
    if (idOrPath !== 'p:guides/a.md' && idOrPath !== 'guides/a.md') return null;
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
    return {
      buildId: BUILD,
      sourceState: 'clean',
      tableId: 'none',
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      elapsedMs: 1,
      locator: {
        artifactId: 'p:none',
        relativePath: 'none',
        displayPath: 'none',
        mediaType: 'text/csv',
      },
    };
  },
};

function runtimeFor() {
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

  return createRuntime({
    provider: {
      async current() {
        return { buildId: BUILD, generation: 7 };
      },
      async acquire(): Promise<BuildHandle> {
        return { buildId: BUILD, generation: 7, release() {} };
      },
    },
    open: async () => scope,
    freshness: async () => 'clean',
  });
}

function registeredRoutes(app: ReturnType<typeof createApiApp>): string[] {
  return app.routes.map((route) => `${route.method} ${route.path}`);
}

const envelope = {
  'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'deploy-cloudflare-tests', version: '0.0.0' },
};

function mcpRequest(method: string): Request {
  return new Request('https://worker.example/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': method,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { _meta: envelope } }),
  });
}

async function decodeMcp(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const payload = text.startsWith('event:')
    ? (text.split('\n').find((line) => line.startsWith('data: ')) ?? '').slice('data: '.length)
    : text;
  return JSON.parse(payload) as Record<string, unknown>;
}

describe('the Worker-facing runtime assembly, issue 86', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) {
      await close();
    }
  });

  function createSurfaces() {
    const runtime = runtimeFor();
    const currentBuild = async () => ({ buildId: BUILD, generation: 7 });
    const localMcp = createMcpHttpHandler(runtime);
    closers.push(() => localMcp.close());
    const local = createApiApp({
      runtime,
      currentBuild,
      freshness: async () => 'clean',
      mcpHandler: (request) => localMcp.fetch(request),
    });

    const worker = createCloudflareWorker({
      runtime,
      currentBuild,
      freshness: async () => 'clean',
    });
    closers.push(() => worker.close());
    return { local, worker };
  }

  it('registers exactly the shared read-only route set, including /mcp', () => {
    const { local, worker } = createSurfaces();
    expect(registeredRoutes(worker.app as ReturnType<typeof createApiApp>)).toEqual(
      registeredRoutes(local),
    );
    expect(registeredRoutes(worker.app as ReturnType<typeof createApiApp>)).toContain('ALL /mcp');
    expect(registeredRoutes(worker.app as ReturnType<typeof createApiApp>)).not.toContain(
      'POST /v1/builds/activate',
    );
  });

  it('exposes the same MCP tool list as the local Hono app', async () => {
    const { local, worker } = createSurfaces();
    const localBody = await decodeMcp(await local.request('/mcp', mcpRequest('tools/list')));
    const workerBody = await decodeMcp(await worker.fetch(mcpRequest('tools/list')));

    const localNames = (localBody.result as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );
    const workerNames = (workerBody.result as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );

    expect(localNames).toEqual([...TOOL_NAMES]);
    expect(workerNames).toEqual(localNames);
  });

  it('rejects MCP header mismatches before the Worker auth hook can inspect them', async () => {
    let authorized = 0;
    const worker = createCloudflareWorker({
      runtime: runtimeFor(),
      currentBuild: async () => ({ buildId: BUILD, generation: 7 }),
      freshness: async () => 'clean',
      authorize: () => {
        authorized += 1;
        return true;
      },
    });
    closers.push(() => worker.close());

    const response = await worker.fetch(
      new Request('https://worker.example/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'lore_context_for_task', arguments: {} },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32020 },
      id: 1,
    });
    expect(authorized).toBe(0);
  });
});
