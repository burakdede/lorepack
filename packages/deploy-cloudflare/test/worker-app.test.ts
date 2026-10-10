import { DatabaseSync } from 'node:sqlite';
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
import {
  createCloudflareWorker,
  createCloudflareWorkerFromBindings,
  hashRuntimeToken,
  type RuntimeAuthDatabaseLike,
  type RuntimeAuthStatementLike,
  storeRuntimeTokenHash,
} from '../src/index.js';

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

/**
 * Files whose names look like percent-encoding, each with a body naming itself (#608).
 *
 * A second decode of the route parameter turned `a%20b.md` into `a b.md`, so the read returned
 * the other file's text under the first one's name, and made a bare `%` a 500.
 */
const ENCODED_NAMES: Readonly<Record<string, string>> = {
  'p:docs/a%20b.md': 'ENCODED-NAME',
  'p:docs/a b.md': 'SPACED-NAME',
  'p:docs/a%2520b.md': 'DOUBLY-ENCODED-NAME',
  'p:docs/100%.md': 'PERCENT-NAME',
};

function encodedNamesRuntime() {
  const byHash = new Map<string, string>();
  const artifacts = new Map<string, CatalogArtifact>();
  Object.entries(ENCODED_NAMES).forEach(([artifactId, body], index) => {
    const hash = String(index).repeat(64);
    const relativePath = artifactId.slice('p:'.length);
    byHash.set(hash, body);
    artifacts.set(artifactId, {
      artifactId,
      relativePath,
      displayPath: relativePath,
      title: body,
      status: 'active',
      authority: 50,
      mediaType: 'text/markdown',
      objectHash: hash,
    });
  });
  const scope: BuildScope = {
    buildId: BUILD,
    catalog: { ...catalog, artifact: async (id: string) => artifacts.get(id) ?? null },
    tables,
    objects: {
      async get(hash: string) {
        const body = byHash.get(hash);
        return body === undefined ? null : new TextEncoder().encode(body);
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

class SqliteRuntimeStatement implements RuntimeAuthStatementLike {
  readonly #db: DatabaseSync;
  readonly #query: string;
  #bindings: readonly unknown[] = [];

  constructor(db: DatabaseSync, query: string) {
    this.#db = db;
    this.#query = query;
  }

  bind(...values: unknown[]): RuntimeAuthStatementLike {
    this.#bindings = values;
    return this;
  }

  async run<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }> {
    const statement = this.#db.prepare(this.#query);
    if (this.#query.trim().toLowerCase().startsWith('select')) {
      return { results: statement.all(...this.#bindings) as readonly T[] };
    }
    statement.run(...this.#bindings);
    return {};
  }
}

class SqliteRuntimeDatabase implements RuntimeAuthDatabaseLike {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  prepare(query: string): RuntimeAuthStatementLike {
    return new SqliteRuntimeStatement(this.#db, query);
  }
}

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
  const databases: DatabaseSync[] = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) {
      await close();
    }
    while (databases.length > 0) {
      databases.pop()?.close();
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

  it('reads every artifact id as its own file, locally and on the Worker, #608', async () => {
    const runtime = encodedNamesRuntime();
    const currentBuild = async () => ({ buildId: BUILD, generation: 7 });
    const local = createApiApp({ runtime, currentBuild });
    const worker = createCloudflareWorker({ runtime, currentBuild });
    closers.push(() => worker.close());
    const surfaces = {
      local: (path: string) => local.request(`https://worker.example${path}`),
      worker: (path: string) => worker.fetch(new Request(`https://worker.example${path}`)),
    };

    for (const [name, read] of Object.entries(surfaces)) {
      for (const [artifactId, body] of Object.entries(ENCODED_NAMES)) {
        const response = await read(`/v1/sources/${encodeURIComponent(artifactId)}`);
        expect(response.status, `${name} ${artifactId}`).toBe(200);
        const json = (await response.json()) as { text: string; locator: { artifactId: string } };
        expect(json.text, `${name} ${artifactId}`).toBe(body);
        expect(json.locator.artifactId).toBe(artifactId);
      }

      // A bare `%` that the client never encoded is not a valid escape. It must still be a
      // typed answer, never a raw `URIError` as a 500.
      const bare = await read('/v1/sources/p%3Adocs%2F100%.md');
      expect(bare.status, `${name} bare %`).toBeLessThan(500);
    }
  });

  it('adds security headers and keeps CORS closed by default', async () => {
    const { worker } = createSurfaces();

    const response = await worker.fetch(
      new Request('https://worker.example/v1/build', {
        headers: { Origin: 'https://evil.example' },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Permissions-Policy')).toBe(
      'camera=(), geolocation=(), microphone=()',
    );
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('answers CORS preflight and echoes an explicitly allowed origin', async () => {
    const runtime = runtimeFor();
    const worker = createCloudflareWorker({
      runtime,
      currentBuild: async () => ({ buildId: BUILD, generation: 7 }),
      freshness: async () => 'clean',
      allowedOrigins: ['https://app.example'],
    });
    closers.push(() => worker.close());

    const preflight = await worker.fetch(
      new Request('https://worker.example/v1/context', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization, content-type',
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(preflight.headers.get('Vary')).toContain('Origin');

    const build = await worker.fetch(
      new Request('https://worker.example/v1/build', {
        headers: { Origin: 'https://app.example' },
      }),
    );
    expect(build.status).toBe(200);
    expect(build.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
  });

  it('parses an allowlist from the deployed Worker bindings', async () => {
    const worker = createCloudflareWorkerFromBindings({
      CATALOG_DB: {
        prepare() {
          throw new Error('the request should stop at CORS preflight');
        },
      } as never,
      TABLES_DB: {} as never,
      OBJECTS: {} as never,
      PROJECT_ID: 'demo',
      ALLOWED_ORIGINS: 'https://app.example, https://admin.example',
    });
    closers.push(() => worker.close());

    const response = await worker.fetch(
      new Request('https://worker.example/v1/build', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://admin.example',
          'Access-Control-Request-Method': 'GET',
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.example');
  });

  it('never echoes rejected bearer or Access tokens in the Worker 401 body', async () => {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    const auth = new SqliteRuntimeDatabase(db);
    await storeRuntimeTokenHash(
      auth,
      await hashRuntimeToken('lore_rt_good'),
      '2026-08-09T12:00:00.000Z',
    );

    const bearerWorker = createCloudflareWorkerFromBindings(
      {
        CATALOG_DB: auth as never,
        TABLES_DB: auth as never,
        OBJECTS: {} as never,
        PROJECT_ID: 'demo',
      },
      { authMode: 'runtime-token' },
    );
    closers.push(() => bearerWorker.close());

    const badBearer = 'lore_rt_secret_that_must_not_echo';
    const bearerResponse = await bearerWorker.fetch(
      new Request('https://worker.example/v1/build', {
        headers: { Authorization: `Bearer ${badBearer}` },
      }),
    );
    const bearerBody = JSON.stringify(await bearerResponse.json());
    expect(bearerResponse.status).toBe(401);
    expect(bearerBody).toContain('This token is not valid for this build.');
    expect(bearerBody).not.toContain(badBearer);

    const accessWorker = createCloudflareWorkerFromBindings(
      {
        CATALOG_DB: {
          prepare() {
            throw new Error('the request should stop at auth');
          },
        } as never,
        TABLES_DB: {} as never,
        OBJECTS: {} as never,
        PROJECT_ID: 'demo',
      },
      {
        authMode: 'disabled',
        access: {
          teamDomain: 'lorepack.cloudflareaccess.com',
          audience: 'cf-access-aud',
          verifyToken: async () => false,
        },
      },
    );
    closers.push(() => accessWorker.close());

    const badAccess = 'access.jwt.must.not.echo';
    const accessResponse = await accessWorker.fetch(
      new Request('https://worker.example/v1/build', {
        headers: { 'Cf-Access-Jwt-Assertion': badAccess },
      }),
    );
    const accessBody = JSON.stringify(await accessResponse.json());
    expect(accessResponse.status).toBe(401);
    expect(accessBody).toContain('This request is not authorized for this build.');
    expect(accessBody).not.toContain(badAccess);
  });
});
