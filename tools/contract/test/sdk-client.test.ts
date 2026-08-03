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
import { LoreError } from '@lorepack/core';
import { createApiApp, createRuntime } from '@lorepack/runtime';
import { LoreClient, LoreClientError } from '@lorepack/sdk';
import { describe, expect, it } from 'vitest';

/**
 * The SDK against the real server, in one process and over no socket.
 *
 * The client's `fetch` is pointed at the Hono app's own request handler, so every method is
 * exercised against the actual routing, validation and error rendering rather than against
 * a mock of them. A mock would agree with whatever the SDK believed.
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
  text: 'rollback restores the previous release without recompiling anything',
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
  async artifacts() {
    return [];
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

function clientOverApp(options: { retries?: number; timeoutMs?: number } = {}): LoreClient {
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

  const app = createApiApp({
    runtime: createRuntime({
      provider: {
        async current() {
          return { buildId: BUILD, generation: 3 };
        },
        async acquire(): Promise<BuildHandle> {
          return { buildId: BUILD, generation: 3, release() {} };
        },
      },
      open: async () => scope,
      freshness: async () => 'clean',
    }),
    currentBuild: async () => ({ buildId: BUILD, generation: 3 }),
    freshness: async () => 'clean',
  });

  return new LoreClient({
    baseUrl: 'http://runtime.test',
    fetch: async (input, init) => app.request(String(input), init as RequestInit),
    ...options,
  });
}

describe('every route has a typed method', () => {
  it('health', async () => {
    const health = await clientOverApp().health();
    expect(health.status).toBe('ok');
    expect(health.generation).toBe(3);
  });

  it('describeBuild', async () => {
    const described = await clientOverApp().describeBuild();
    expect(described.projectName).toBe('demo');
    expect(described.buildId).toBe(BUILD);
  });

  it('search', async () => {
    const result = await clientOverApp().search({ query: 'rollback' });
    expect(result.hits[0]?.locator.relativePath).toBe('guides/a.md');
  });

  it('contextForTask', async () => {
    const bundle = await clientOverApp().contextForTask({ task: 'how do I roll back' });
    expect(bundle.profile).toBe('agent');
    expect(bundle.estimatedTokens).toBeLessThanOrEqual(bundle.budget);
  });

  it('readSource, whole and by range', async () => {
    const client = clientOverApp();
    expect((await client.readSource('p:guides/a.md')).text).toContain('normalized body');

    const ranged = await client.readSource('p:guides/a.md', { lineStart: 3, lineEnd: 4 });
    expect(ranged.text).toBe('the only node');
    expect(ranged.locator.lineStart).toBe(3);
  });

  it('the table routes', async () => {
    const client = clientOverApp();
    expect(await client.listTables()).toEqual({ tables: [] });
    await expect(client.describeTable('sales')).rejects.toBeInstanceOf(LoreClientError);
  });
});

describe('errors keep the server code', () => {
  it('maps a server failure to a typed client error', async () => {
    try {
      await clientOverApp().describeTable('sales');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LoreClientError);
      const failure = error as LoreClientError;
      expect(failure.code).toBe('LORE_E_BUILD_NOT_FOUND');
      expect(failure.status).toBe(404);
      expect(failure.remediation).toBeDefined();
    }
  });

  it('does not retry a request the server rejected, because asking again cannot help', async () => {
    let calls = 0;
    const client = new LoreClient({
      baseUrl: 'http://runtime.test',
      retries: 5,
      fetch: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ error: { code: 'LORE_E_INVALID_ARGUMENT', message: 'no' } }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    });

    await expect(client.describeBuild()).rejects.toBeInstanceOf(LoreClientError);
    expect(calls).toBe(1);
  });

  it('retries a GET that never reached a server, and gives up eventually', async () => {
    let calls = 0;
    const client = new LoreClient({
      baseUrl: 'http://runtime.test',
      retries: 3,
      fetch: async () => {
        calls += 1;
        throw new TypeError('fetch failed');
      },
    });

    await expect(client.describeBuild()).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(3);
  });

  it('never retries a POST, however it failed', async () => {
    let calls = 0;
    const client = new LoreClient({
      baseUrl: 'http://runtime.test',
      retries: 5,
      fetch: async () => {
        calls += 1;
        throw new TypeError('fetch failed');
      },
    });

    await expect(client.search({ query: 'a' })).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(1);
  });
});

describe('cancellation', () => {
  it('honours a caller supplied signal', async () => {
    const controller = new AbortController();
    const client = new LoreClient({
      baseUrl: 'http://runtime.test',
      retries: 1,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });

    const pending = client.describeBuild(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it('gives up on its own timeout', async () => {
    const client = new LoreClient({
      baseUrl: 'http://runtime.test',
      timeoutMs: 20,
      retries: 1,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () => {
            reject(new DOMException('timed out', 'TimeoutError'));
          });
        }),
    });

    await expect(client.describeBuild()).rejects.toThrow(/timed out/i);
  });
});

describe('the ten line example from the README actually runs', () => {
  it('connects, describes the build, asks for context, prints citations', async () => {
    const client = clientOverApp();

    const build = await client.describeBuild();
    const bundle = await client.contextForTask({ task: 'how do I roll back a release' });
    const lines = bundle.citations.map(
      (citation) =>
        `${citation.relativePath}${citation.lineStart === undefined ? '' : `:${citation.lineStart}`}`,
    );

    expect(build.projectName).toBe('demo');
    expect(lines.every((line) => line.includes('guides/a.md'))).toBe(true);
  });
});
