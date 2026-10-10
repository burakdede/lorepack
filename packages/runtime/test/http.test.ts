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
import { LoreError } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import {
  type AuthorizationRequest,
  createApiApp,
  DEFAULT_MAX_REQUEST_BYTES,
  UNAUTHENTICATED_PATHS,
} from '../src/http/app.js';
import { createRuntime } from '../src/runtime.js';

/**
 * The REST surface, driven through Hono's request client.
 *
 * No socket is opened: `app.request()` runs the same handlers a server would, which is the
 * point of a framework that runs on Node and on a Worker. What is being tested is the
 * routing, the validation and the safety rules, none of which need a port.
 */

const BUILD = `lore_${'a'.repeat(64)}` as BuildId;

const HIT: CatalogSearchHit = {
  chunkId: 'p:guides/a.md@0',
  artifactId: 'p:guides/a.md',
  relativePath: 'guides/a.md',
  displayPath: 'guides/a.md',
  headingPath: ['Guides'],
  page: null,
  sheet: null,
  cellRange: null,
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

/** The criteria the last search reached the store with, for asserting a filter arrived. */
let lastCriteria: CatalogSearchCriteria | null = null;

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
    lastCriteria = criteria;
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
        page: null,
        sheet: null,
        cellRange: null,
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

function appFor(overrides: Partial<Parameters<typeof createApiApp>[0]> = {}) {
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

  const runtime = createRuntime({
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

  return createApiApp({
    runtime,
    currentBuild: async () => ({ buildId: BUILD, generation: 7 }),
    freshness: async () => 'clean',
    ...overrides,
  });
}

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

function registeredRoutes(app: ReturnType<typeof appFor>): string[] {
  return app.routes.map((route) => `${route.method} ${route.path}`);
}

describe('the route list, architecture 14.5', () => {
  it('answers GET /health with the build, the generation and the freshness', async () => {
    const response = await appFor().request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      buildId: BUILD,
      generation: 7,
      sourceState: 'clean',
    });
  });

  it('answers GET /v1/build', async () => {
    const response = await appFor().request('/v1/build');
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body.projectName).toBe('demo');
    expect(body.buildId).toBe(BUILD);
  });

  it('answers POST /v1/search', async () => {
    const response = await appFor().request('/v1/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'rollback' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = (await response.json()) as { hits: Array<{ locator: { relativePath: string } }> };
    expect(response.status).toBe(200);
    expect(body.hits[0]?.locator.relativePath).toBe('guides/a.md');
  });

  it('answers POST /v1/context', async () => {
    const response = await appFor().request('/v1/context', {
      method: 'POST',
      body: JSON.stringify({ task: 'how do I roll back' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = (await response.json()) as { budget: number; citations: unknown[] };
    expect(response.status).toBe(200);
    expect(body.budget).toBe(12_000);
  });

  it('answers GET /v1/sources/:artifactId, with an optional range', async () => {
    const whole = await appFor().request('/v1/sources/p%3Aguides%2Fa.md');
    expect(whole.status).toBe(200);

    const ranged = await appFor().request('/v1/sources/p%3Aguides%2Fa.md?lineStart=3&lineEnd=4');
    const body = (await ranged.json()) as { text: string; locator: { lineStart: number } };
    expect(body.text).toBe('the only node');
    expect(body.locator.lineStart).toBe(3);

    const page = await appFor().request('/v1/sources/p%3Aguides%2Fa.md?page=2');
    expect(page.status).toBe(400);
  });

  it('answers the table routes as a build without tables, until Phase 5', async () => {
    const list = await appFor().request('/v1/tables');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ tables: [] });

    const one = await appFor().request('/v1/tables/sales');
    expect(one.status).toBe(404);
    expect(((await one.json()) as { error: { code: string } }).error.code).toBe(
      'LORE_E_BUILD_NOT_FOUND',
    );
  });

  it('has no other routes, and says so in the same shape as every other failure', async () => {
    const response = await appFor().request('/v1/admin/rebuild', { method: 'POST' });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'LORE_E_INVALID_ARGUMENT',
    );
  });
});

describe('every response carries the build it read', () => {
  // Each route gets its own body: the request schemas are strict, so sending a search body
  // to the context route is a validation failure rather than a lenient success.
  it.each([
    ['/v1/build', 'GET', undefined],
    ['/v1/search', 'POST', JSON.stringify({ query: 'a' })],
    ['/v1/context', 'POST', JSON.stringify({ task: 'a' })],
  ] as const)('%s', async (path, method, body) => {
    const response = await appFor().request(path, {
      method,
      ...(body === undefined ? {} : { body }),
      headers: { 'Content-Type': 'application/json' },
    });
    const parsed = (await response.json()) as { buildId: string; sourceState: string };
    expect(response.status).toBe(200);
    expect(parsed.buildId).toBe(BUILD);
    expect(parsed.sourceState).toBe('clean');
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    const response = await appFor().request('/v1/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'a', task: 'a' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
  });
});

describe('validation names the field that was wrong', () => {
  it('reports the JSON path of the first offending value', async () => {
    const response = await appFor().request('/v1/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'rollback', limit: 5000 }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = (await response.json()) as {
      error: { code: string; message: string; subject?: string };
    };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('LORE_E_INVALID_ARGUMENT');
    expect(body.error.subject).toBe('limit');
    expect(body.error.message).toContain('limit');
  });

  it('refuses a body that is not JSON at all', async () => {
    const response = await appFor().request('/v1/search', {
      method: 'POST',
      body: 'not json',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      'not valid JSON',
    );
  });

  it('refuses a query string range that is not a line number', async () => {
    const response = await appFor().request('/v1/sources/p%3Aguides%2Fa.md?lineStart=nonsense');
    expect(response.status).toBe(400);
  });
});

describe('safety, architecture 19.4 and 20.9', () => {
  it('refuses a cross-origin browser request to everything except health', async () => {
    const app = appFor();
    const blocked = await app.request('/v1/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'a' }),
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    });
    expect(blocked.status).toBe(403);

    const health = await app.request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(health.status).toBe(200);
  });

  it('allows an origin that was explicitly configured, which is how Studio will connect', async () => {
    const app = appFor({ allowedOrigins: ['http://localhost:4321'] });
    const response = await app.request('/v1/build', {
      headers: { Origin: 'http://localhost:4321' },
    });
    expect(response.status).toBe(200);
  });

  it('lets a client with no Origin header through, which is every tool and SDK', async () => {
    expect((await appFor().request('/v1/build')).status).toBe(200);
  });

  it('refuses an oversized body by its declared length and by its real length', async () => {
    const app = appFor({ maxRequestBytes: 100 });

    const declared = await app.request('/v1/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'x'.repeat(500) }),
      headers: { 'Content-Type': 'application/json', 'Content-Length': '5000' },
    });
    expect(declared.status).toBe(413);

    // A lying Content-Length must not get past the check.
    const lied = await app.request('/v1/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'x'.repeat(500) }),
      headers: { 'Content-Type': 'application/json', 'Content-Length': '10' },
    });
    expect(lied.status).toBe(413);
  });

  it('treats a traversal in an artifact id as a miss, not a path', async () => {
    for (const artifactId of [
      '..%2F..%2Fetc%2Fpasswd',
      '%2Fetc%2Fpasswd',
      'guides%2F..%2F..%2Fx',
    ]) {
      const response = await appFor().request(`/v1/sources/${artifactId}`);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'LORE_E_BUILD_NOT_FOUND',
      );
    }
  });

  it('has no route that could change anything', async () => {
    const app = appFor();
    for (const [method, path] of [
      ['POST', '/v1/build'],
      ['DELETE', '/v1/build'],
      ['PUT', '/v1/sources/p%3Aguides%2Fa.md'],
      ['POST', '/v1/deploy'],
      ['POST', '/v1/exec'],
    ] as const) {
      const response = await app.request(path, { method });
      expect([404, 405], `${method} ${path}`).toContain(response.status);
    }
  });
});

/**
 * DNS rebinding, which an `Origin` check cannot see (#547).
 *
 * After a rebind the attacker's page is same-origin with this server, and a browser sends no
 * `Origin` on a same-origin `GET`. What it cannot change is the `Host` header: that names the
 * attacker's hostname, because that is the URL the page fetched.
 */
describe('the Host header, which DNS rebinding cannot forge', () => {
  it.each([
    ['GET', '/v1/sources/p%3Aguides%2Fa.md'],
    ['GET', '/v1/build'],
    ['GET', '/v1/tables'],
    ['GET', '/health'],
    ['POST', '/mcp'],
    ['GET', '/'],
  ] as const)('refuses a foreign Host before any handler runs: %s %s', async (method, path) => {
    const reached: string[] = [];
    const app = appFor({
      allowedHosts: LOOPBACK,
      mcpHandler: () => {
        reached.push('mcp');
        return new Response('{}');
      },
      assets: () => {
        reached.push('assets');
        return new Response('<html></html>');
      },
    });

    const response = await app.request(path, {
      method,
      headers: { Host: 'attacker.example:4321' },
    });
    const body = (await response.json()) as { error: { code: string; subject?: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('LORE_E_INVALID_ARGUMENT');
    expect(body.error.subject).toBe('attacker.example:4321');
    expect(JSON.stringify(body)).not.toContain('the only node');
    expect(reached).toEqual([]);
  });

  it('answers the loopback names on any port, which is every local client', async () => {
    const app = appFor({ allowedHosts: LOOPBACK });
    for (const host of ['127.0.0.1:4321', 'localhost:43110', '[::1]:4321', 'LOCALHOST:4321']) {
      const response = await app.request('/v1/build', { headers: { Host: host } });
      expect(response.status, host).toBe(200);
    }
  });

  it('refuses names that merely start or end like a loopback name', async () => {
    const app = appFor({ allowedHosts: LOOPBACK });
    for (const host of [
      'localhost.attacker.example',
      '127.0.0.1.nip.io:4321',
      'attacker.example@127.0.0.1',
      '127.0.0.1@attacker.example',
      '',
    ]) {
      const response = await app.request('/v1/build', { headers: { Host: host } });
      expect(response.status, host).toBe(403);
    }
  });

  it('refuses a request with no Host at all, which no real client sends', async () => {
    const response = await appFor({ allowedHosts: LOOPBACK }).request('/v1/build');
    expect(response.status).toBe(403);
  });

  it('answers an explicit non-loopback bind address the host added', async () => {
    const app = appFor({ allowedHosts: [...LOOPBACK, '192.168.0.162'] });
    const response = await app.request('/v1/build', { headers: { Host: '192.168.0.162:4321' } });
    expect(response.status).toBe(200);
  });

  it('checks nothing when no list is given, which is a Worker behind its own hostname', async () => {
    const response = await appFor().request('/v1/build', {
      headers: { Host: 'lorepack.example.workers.dev' },
    });
    expect(response.status).toBe(200);
  });
});

describe('diagnostics, which read the machine rather than the build', () => {
  it('is absent unless a host supplies it, because a deployment answers differently', async () => {
    expect((await appFor().request('/v1/diagnostics')).status).toBe(404);
  });

  it('answers with whatever the host reports, unmodified', async () => {
    // Architecture 13.1 fixes the runtime at seven capabilities and a diagnostic is not one
    // of them, so this arrives as an injected function exactly as `currentBuild` does.
    const app = appFor({ diagnostics: async () => ({ doctor: { status: 'pass' } }) });
    const response = await app.request('/v1/diagnostics');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ doctor: { status: 'pass' } });
  });
});

/**
 * The one place this API can write, and the two things that keep it local.
 *
 * A remote deployment has no build history to hand over, so it passes no `localActions` and
 * these routes are never registered. Where they are registered, a browser origin must be a
 * loopback literal, and `allowedOrigins` cannot widen that: adding a remote origin so a team
 * can read a deployment is not the same as letting it activate a build.
 */
describe('the write surface, architecture 15.6 and 19.4', () => {
  const WRITES = [
    ['GET', '/v1/builds', undefined],
    ['GET', `/v1/builds/${BUILD}/diff/${BUILD}`, undefined],
    ['POST', '/v1/builds/activate', JSON.stringify({ build: BUILD })],
    ['POST', '/v1/builds/rollback', '{}'],
    ['POST', '/v1/builds/pack', '{}'],
  ] as const;

  function actionsFor(): {
    calls: string[];
    actions: NonNullable<Parameters<typeof createApiApp>[0]['localActions']>;
  } {
    const calls: string[] = [];
    return {
      calls,
      actions: {
        builds: async () => {
          calls.push('builds');
          return { activeBuildId: BUILD, builds: [] };
        },
        diff: async (from, to) => {
          calls.push(`diff ${from} ${to}`);
          return { from, to, identical: true };
        },
        activate: async (request) => {
          calls.push('activate');
          return { ...(request as object), changed: true };
        },
        rollback: async () => {
          calls.push('rollback');
          return { buildId: BUILD, changed: true };
        },
        pack: async () => {
          calls.push('pack');
          return { buildId: BUILD, archive: '/tmp/a.lorepack', members: 4 };
        },
      },
    };
  }

  it('registers no build-changing routes when the host supplies no local actions', () => {
    const routes = registeredRoutes(appFor());

    expect(routes).not.toContain('GET /v1/builds');
    expect(routes).not.toContain('GET /v1/builds/:from/diff/:to');
    expect(routes).not.toContain('POST /v1/builds/activate');
    expect(routes).not.toContain('POST /v1/builds/rollback');
    expect(routes).not.toContain('POST /v1/builds/pack');
    // The remote criterion is about route registration, not HTTP verbs. This POST is a
    // read route and must stay present.
    expect(routes).toContain('POST /v1/tables/:tableId/query');
  });

  it('registers the full local write surface only when the host supplies actions', () => {
    const { actions } = actionsFor();
    const routes = registeredRoutes(appFor({ localActions: actions }));

    expect(routes).toContain('GET /v1/builds');
    expect(routes).toContain('GET /v1/builds/:from/diff/:to');
    expect(routes).toContain('POST /v1/builds/activate');
    expect(routes).toContain('POST /v1/builds/rollback');
    expect(routes).toContain('POST /v1/builds/pack');
  });

  it.each(WRITES)(
    'is absent entirely when the host supplies no actions: %s %s',
    async (method, path, body) => {
      const response = await appFor().request(path, {
        method,
        ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }),
      });
      // 404 rather than 403: a route a remote deployment does not have cannot be reached by
      // finding a way past a check, because there is no check to get past.
      expect(response.status).toBe(404);
    },
  );

  it.each(WRITES)('answers where a host supplied actions: %s %s', async (method, path, body) => {
    const { actions } = actionsFor();
    const response = await appFor({ localActions: actions }).request(path, {
      method,
      ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }),
    });
    expect(response.status).toBe(200);
  });

  it.each(WRITES)('refuses a non-loopback browser origin: %s %s', async (method, path, body) => {
    const { calls, actions } = actionsFor();
    const app = appFor({
      localActions: actions,
      // Configured for reads, and deliberately powerless here.
      allowedOrigins: ['https://team.example'],
    });

    const response = await app.request(path, {
      method,
      headers: {
        Origin: 'https://team.example',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body }),
    });

    expect(response.status).toBe(403);
    // The refusal happens before the action runs, so nothing was half done.
    expect(calls).toEqual([]);
  });

  it('accepts a page served from this machine, which is what Studio is', async () => {
    const { calls, actions } = actionsFor();
    const app = appFor({ localActions: actions, allowedHosts: LOOPBACK, allowSameOrigin: true });

    const response = await app.request('/v1/builds', {
      headers: { Host: '127.0.0.1:4321', Origin: 'http://127.0.0.1:4321' },
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual(['builds']);
  });

  /**
   * Another server on this machine is not Studio (#548).
   *
   * A dev server with an XSS, a malicious package's preview, a local HTML file served on some
   * port: each is a loopback origin, and none of them is the page this server served.
   */
  it.each(WRITES)('refuses a loopback page on another port: %s %s', async (method, path, body) => {
    const { calls, actions } = actionsFor();
    const app = appFor({ localActions: actions, allowedHosts: LOOPBACK, allowSameOrigin: true });

    for (const origin of ['http://localhost:8080', 'http://127.0.0.1:9999']) {
      const response = await app.request(path, {
        method,
        headers: {
          Host: '127.0.0.1:4321',
          Origin: origin,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, origin).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it('accepts Studio through a dev proxy, where page and Host share the proxy port', async () => {
    const { calls, actions } = actionsFor();
    const app = appFor({ localActions: actions, allowedHosts: LOOPBACK, allowSameOrigin: true });

    const response = await app.request('/v1/builds/rollback', {
      method: 'POST',
      headers: {
        Host: 'localhost:5173',
        Origin: 'http://localhost:5173',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual(['rollback']);
  });

  it('will not let an HTTP caller choose where an archive is written', async () => {
    const { calls, actions } = actionsFor();
    const app = appFor({ localActions: actions });

    for (const out of ['/tmp/victim.txt', '../../outside.lorepack', 'archive.lorepack']) {
      const response = await app.request('/v1/builds/pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ out }),
      });
      const parsed = (await response.json()) as { error: { code: string; message: string } };
      expect(response.status, out).toBe(400);
      expect(parsed.error.code).toBe('LORE_E_INVALID_ARGUMENT');
    }
    expect(calls).toEqual([]);
  });

  it('validates the body before anything is activated', async () => {
    const { calls, actions } = actionsFor();
    const app = appFor({ localActions: actions });

    const response = await app.request('/v1/builds/activate', {
      method: 'POST',
      body: JSON.stringify({ buildId: BUILD }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

/**
 * A JSON route takes JSON, and says so to anything else (#548).
 *
 * `text/plain`, `application/x-www-form-urlencoded` and `multipart/form-data` are the content
 * types a page can send cross-origin without a CORS preflight. Refusing them means a hostile
 * page has to ask first, and the server never says yes to a foreign origin.
 */
describe('the request media type', () => {
  const JSON_ROUTES = [
    ['/v1/search', JSON.stringify({ query: 'a' })],
    ['/v1/context', JSON.stringify({ task: 'a' })],
    ['/v1/export', JSON.stringify({ task: 'a' })],
    ['/v1/tables/sales/query', JSON.stringify({ sql: 'SELECT 1' })],
    ['/v1/builds/activate', JSON.stringify({ build: BUILD })],
    ['/v1/builds/rollback', '{}'],
    ['/v1/builds/pack', '{}'],
  ] as const;

  function fullApp(calls: string[]): ReturnType<typeof appFor> {
    const record = async (name: string) => {
      calls.push(name);
      return { ok: true };
    };
    return appFor({
      exportBundle: async () => {
        calls.push('export');
        return '# bundle';
      },
      localActions: {
        builds: () => record('builds'),
        diff: () => record('diff'),
        activate: () => record('activate'),
        rollback: () => record('rollback'),
        pack: () => record('pack'),
      },
    });
  }

  it.each(JSON_ROUTES)('refuses a simple-request body with 415: %s', async (path, body) => {
    const calls: string[] = [];
    const app = fullApp(calls);
    for (const type of [
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      undefined,
    ]) {
      const response = await app.request(path, {
        method: 'POST',
        body,
        ...(type === undefined ? {} : { headers: { 'Content-Type': type } }),
      });
      const parsed = (await response.json()) as { error: { code: string } };
      expect(response.status, String(type)).toBe(415);
      expect(parsed.error.code).toBe('LORE_E_INVALID_ARGUMENT');
    }
    expect(calls).toEqual([]);
  });

  it('accepts JSON with parameters and in any case', async () => {
    for (const type of ['application/json; charset=utf-8', 'Application/JSON']) {
      const response = await appFor().request('/v1/search', {
        method: 'POST',
        body: JSON.stringify({ query: 'rollback' }),
        headers: { 'Content-Type': type },
      });
      expect(response.status, type).toBe(200);
    }
  });
});

describe('errors', () => {
  it('renders through the taxonomy, with a code and a remediation', async () => {
    const response = await appFor().request('/v1/tables/missing');
    const body = (await response.json()) as {
      error: { code: string; message: string; remediation?: string };
    };
    expect(body.error.code).toBe('LORE_E_BUILD_NOT_FOUND');
    expect(body.error.remediation).toBeDefined();
  });

  it('redacts a secret that reached a message, wherever it came from', async () => {
    const previous = process.env.LOREPACK_TEST_TOKEN;
    process.env.LOREPACK_TEST_TOKEN = 'super-secret-value';
    try {
      const app = createApiApp({
        runtime: {
          describeBuild: async () => {
            throw new LoreError('LORE_E_INTERNAL', 'failed talking to super-secret-value');
          },
        } as never,
        currentBuild: async () => null,
      });
      const response = await app.request('/v1/build');
      expect(await response.text()).not.toContain('super-secret-value');
    } finally {
      if (previous === undefined) delete process.env.LOREPACK_TEST_TOKEN;
      else process.env.LOREPACK_TEST_TOKEN = previous;
    }
  });
});

describe('concurrency', () => {
  it('releases a handle per request, under load', async () => {
    let acquired = 0;
    let released = 0;
    const scope: BuildScope = {
      buildId: BUILD,
      catalog,
      tables,
      objects: {
        async get() {
          return null;
        },
        async put() {
          return '';
        },
        async has() {
          return false;
        },
      },
    };
    const runtime = createRuntime({
      provider: {
        async current() {
          return { buildId: BUILD, generation: 1 };
        },
        async acquire() {
          acquired += 1;
          return {
            buildId: BUILD,
            generation: 1,
            release() {
              released += 1;
            },
          };
        },
      },
      open: async () => scope,
    });
    const app = createApiApp({ runtime, currentBuild: async () => null });

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        app.request(index % 2 === 0 ? '/v1/build' : '/v1/tables'),
      ),
    );

    expect(acquired).toBe(40);
    expect(released).toBe(40);
  });
});

describe('the default body limit', () => {
  it('is generous enough for a real request and small enough to matter', () => {
    expect(DEFAULT_MAX_REQUEST_BYTES).toBeGreaterThan(64 * 1024);
    expect(DEFAULT_MAX_REQUEST_BYTES).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});

describe('the authorization hook, architecture 18.4', () => {
  /** Every route a client can reach, as a caller would call it. */
  const ROUTES: Array<[string, RequestInit]> = [
    ['/v1/build', {}],
    ['/v1/search', { method: 'POST', body: JSON.stringify({ query: 'a' }) }],
    ['/v1/context', { method: 'POST', body: JSON.stringify({ task: 'a' }) }],
    ['/v1/sources/p%3Aguides%2Fa.md', {}],
    ['/v1/tables', {}],
    ['/v1/tables/sales', {}],
    ['/v1/tables/sales/query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }) }],
    ['/mcp', { method: 'POST', body: '{}' }],
    ['/no/such/route', {}],
  ];

  it('is absent by default, which is what a loopback server wants', async () => {
    // A token the user issued to themselves, to reach a port only they can reach, protects
    // nothing and is one more thing to get wrong.
    const response = await appFor().request('/v1/build');
    expect(response.status).toBe(200);
  });

  it.each(ROUTES)('refuses %s when the hook declines', async (path, init) => {
    const app = appFor({
      authorize: () => false,
      mcpHandler: () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    });
    const response = await app.request(path, {
      ...init,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'LORE_E_INVALID_ARGUMENT' } });
  });

  it('exempts /health, because a probe has no credential and reveals no content', async () => {
    const app = appFor({ authorize: () => false });
    expect(UNAUTHENTICATED_PATHS).toEqual(['/health']);
    const response = await app.request('/health');
    expect(response.status).toBe(200);
  });

  it('admits the request when the hook returns true', async () => {
    const app = appFor({ authorize: () => true });
    const response = await app.request('/v1/build');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ buildId: BUILD });
  });

  it('sees the credential, the method and the path', async () => {
    const seen: AuthorizationRequest[] = [];
    const app = appFor({
      authorize: (request) => {
        seen.push(request);
        return request.authorization === 'Bearer good';
      },
    });

    const allowed = await app.request('/v1/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'a' }),
      headers: { Authorization: 'Bearer good', 'Content-Type': 'application/json' },
    });
    expect(allowed.status).toBe(200);

    const refused = await app.request('/v1/build', { headers: { Authorization: 'Bearer wrong' } });
    expect(refused.status).toBe(401);

    expect(seen[0]).toMatchObject({
      authorization: 'Bearer good',
      method: 'POST',
      path: '/v1/search',
    });
    expect(seen[0]?.headers.get('Content-Type')).toBe('application/json');
  });

  it('reports the reason a decision gives, so a caller learns which credential is wrong', async () => {
    const app = appFor({ authorize: () => 'This token has expired.' });
    const response = await app.request('/v1/build');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { message: 'This token has expired.' },
    });
  });

  it('awaits an asynchronous decision, since a real check calls something', async () => {
    const app = appFor({
      authorize: async (request) => request.authorization === 'Bearer good',
    });
    expect((await app.request('/v1/build')).status).toBe(401);
    expect(
      (await app.request('/v1/build', { headers: { Authorization: 'Bearer good' } })).status,
    ).toBe(200);
  });

  it('runs before the route, so a refused request never reaches the runtime', async () => {
    let reads = 0;
    const app = appFor({
      authorize: () => false,
      runtime: {
        async describeBuild() {
          reads += 1;
          throw new Error('unreachable');
        },
      } as never,
    });
    expect((await app.request('/v1/build')).status).toBe(401);
    expect(reads).toBe(0);
  });

  it('rejects an MCP method-header mismatch before the handler sees it', async () => {
    let authorized = 0;
    let handled = 0;
    const app = appFor({
      authorize: () => {
        authorized += 1;
        return true;
      },
      mcpHandler: () => {
        handled += 1;
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      },
    });

    const response = await app.request('/mcp', {
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
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32020 },
      id: 1,
    });
    // After the hook since #550: parsing a body for an anonymous caller is the cost an
    // attacker controls. The forged header still never reaches the handler.
    expect(authorized).toBe(1);
    expect(handled).toBe(0);
  });

  it('rejects an MCP name-header mismatch before the handler sees it', async () => {
    let authorized = 0;
    let handled = 0;
    const app = appFor({
      authorize: () => {
        authorized += 1;
        return true;
      },
      mcpHandler: () => {
        handled += 1;
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      },
    });

    const response = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'lore_search',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'lore_context_for_task', arguments: {} },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32020 },
      id: 1,
    });
    // After the hook since #550: parsing a body for an anonymous caller is the cost an
    // attacker controls. The forged header still never reaches the handler.
    expect(authorized).toBe(1);
    expect(handled).toBe(0);
  });
});

describe('request bodies are capped as they stream, #550', () => {
  const LIMIT = 1024;
  const CHUNK = 256;

  /**
   * A body with no `Content-Length`, as a chunked upload arrives, that counts what was read.
   *
   * Effectively endless: a reader that buffers before checking would run until the test times
   * out, which is the defect, and one that stops at the cap pulls little more than it.
   */
  function endlessBody(): { body: ReadableStream<Uint8Array>; pulled: () => number } {
    let pulled = 0;
    const chunk = new TextEncoder().encode(`{"query":"${'x'.repeat(CHUNK)}`.slice(0, CHUNK));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > 64 * 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    return { body, pulled: () => pulled };
  }

  function chunkedPost(path: string, body: ReadableStream<Uint8Array>, headers = {}): Request {
    return new Request(`http://runtime.test${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
      duplex: 'half',
    } as RequestInit);
  }

  it.each(['/v1/search', '/v1/context', '/mcp'])(
    'stops reading a chunked body to %s once it crosses the cap',
    async (path) => {
      let handled = 0;
      const app = appFor({
        maxRequestBytes: LIMIT,
        mcpHandler: async (request) => {
          handled += 1;
          await request.text();
          return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
        },
      });
      const { body, pulled } = endlessBody();

      const response = await app.request(chunkedPost(path, body));

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { code: 'LORE_E_LIMIT_EXCEEDED' } });
      expect(pulled()).toBeLessThanOrEqual(LIMIT + 2 * CHUNK);
      expect(handled).toBe(0);
    },
  );

  it('refuses an anonymous /mcp request as 401 without reading its body', async () => {
    let handled = 0;
    const app = appFor({
      authorize: () => false,
      mcpHandler: () => {
        handled += 1;
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      },
    });
    const { body, pulled } = endlessBody();

    const response = await app.request(
      chunkedPost('/mcp', body, { 'Mcp-Method': 'tools/list', Accept: 'application/json' }),
    );

    expect(response.status).toBe(401);
    expect(pulled()).toBeLessThanOrEqual(CHUNK);
    expect(handled).toBe(0);
  });

  it('still admits a chunked body under the cap', async () => {
    const app = appFor({ maxRequestBytes: LIMIT });
    const payload = new TextEncoder().encode(JSON.stringify({ query: 'rollback' }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const response = await app.request(chunkedPost('/v1/search', body));
    expect(response.status).toBe(200);
  });
});

describe('search filters reach the store, architecture 14.5', () => {
  async function searchWith(body: Record<string, unknown>): Promise<Response> {
    lastCriteria = null;
    return appFor().request('/v1/search', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('passes an artifact id through unchanged', async () => {
    const response = await searchWith({ query: 'rollback', artifactId: 'p:guides/a.md' });
    expect(response.status).toBe(200);
    expect(lastCriteria?.artifactId).toBe('p:guides/a.md');
  });

  it('leaves it unset when the caller does not ask, so an absent filter filters nothing', async () => {
    const response = await searchWith({ query: 'rollback' });
    expect(response.status).toBe(200);
    expect(lastCriteria?.artifactId).toBeUndefined();
  });

  it('refuses an empty artifact id rather than treating it as no filter', async () => {
    const response = await searchWith({ query: 'rollback', artifactId: '' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { subject: 'artifactId' } });
  });
});
