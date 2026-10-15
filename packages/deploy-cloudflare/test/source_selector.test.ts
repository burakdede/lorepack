import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createLocalRuntimeBackend,
  LocalStateStore,
  stateMigrationsDirectory,
} from '@lorepack/backend-local';
import {
  assertBuildId,
  type BuildScope,
  buildManifestSchema,
  type LoreRuntime,
  sourceReadResultSchema,
} from '@lorepack/core';
import { createMcpHttpHandler, MCP_PROTOCOL_VERSION } from '@lorepack/mcp';
import { createApiApp, createRuntime } from '@lorepack/runtime';
import { describe, expect, it } from 'vitest';
import { importArchive } from '../../cli/src/services/importing.js';
import { run } from '../../cli/test/helpers.js';
import { LoreClient } from '../../sdk/src/client.js';
import {
  createCloudflareDeploymentTarget,
  createCloudflareWorkerFromBindings,
  D1ActiveBuildProvider,
  D1CatalogStore,
  D1TableStore,
  R2ObjectStore,
} from '../src/index.js';
import { FakeR2Bucket, SqliteProjectionDatabase } from './projected-runtime-fixture.js';

const ARCHIVE = join(import.meta.dirname, '../../../fixtures/builds/source_selector.lorepack');
const ORIGIN = 'http://selector.test';
const CORPUS = `corpus_${'c'.repeat(32)}`;
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'selector-contract', version: '0.0.0' },
};

interface Fixture {
  root: string;
  buildId: string;
  runtime: LoreRuntime;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

async function createFixture(kind: 'local' | 'projected'): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'lore-selector-contract-'));
  const imported = await importArchive(root, ARCHIVE);
  const lore = join(root, '.lore');
  const state = LocalStateStore.open(lore, stateMigrationsDirectory());
  try {
    state.activate(assertBuildId(imported.buildId));
  } finally {
    state.close();
  }
  if (kind === 'local') {
    const backend = createLocalRuntimeBackend({ projectRoot: root });
    const runtime = createRuntime(backend);
    const mcp = createMcpHttpHandler(runtime);
    const app = createApiApp({
      runtime,
      currentBuild: () => backend.provider.current(),
      mcpHandler: (request) => mcp.fetch(request),
    });
    return {
      root,
      buildId: imported.buildId,
      runtime,
      fetch: async (request) => await app.fetch(request),
      close: async () => {
        await mcp.close();
        backend.close();
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      },
    };
  }
  const projection = new SqliteProjectionDatabase(new DatabaseSync(':memory:'));
  const bucket = new FakeR2Bucket();
  const target = createCloudflareDeploymentTarget({
    corpusId: CORPUS,
    projectId: 'demo',
    endpoint: `${ORIGIN}/mcp`,
    catalogDb: projection,
    objects: bucket,
  });
  const directory = join(lore, 'builds', imported.buildId);
  const manifest = buildManifestSchema.parse(
    JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')),
  );
  const plan = await target.plan({
    corpusId: CORPUS,
    projectName: 'demo',
    buildId: assertBuildId(imported.buildId),
    buildDirectory: directory,
    buildCapabilities: manifest.capabilities,
  });
  const receipt = await target.apply(plan);
  await target.verify(receipt);
  await target.activate(receipt);
  const provider = new D1ActiveBuildProvider(projection, 'demo');
  const runtime = createRuntime({
    provider,
    open: async (handle): Promise<BuildScope> => ({
      corpusId: handle.corpusId,
      namespaceId: handle.namespaceId,
      buildId: handle.buildId,
      catalog: new D1CatalogStore({
        db: projection,
        namespace: { projectId: 'demo', buildId: handle.buildId },
        manifestJson: provider.manifestFor(handle),
      }),
      tables: new D1TableStore(projection, { projectId: 'demo', buildId: handle.buildId }),
      objects: new R2ObjectStore('demo', bucket),
    }),
  });
  const worker = createCloudflareWorkerFromBindings({
    CATALOG_DB: projection,
    TABLES_DB: projection,
    OBJECTS: bucket,
    PROJECT_ID: 'demo',
  });
  return {
    root,
    buildId: imported.buildId,
    runtime,
    fetch: async (request) => await worker.fetch(request),
    close: async () => {
      await worker.close();
      projection.raw.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

async function withFixture(kind: 'local' | 'projected', body: (fixture: Fixture) => Promise<void>) {
  const fixture = await createFixture(kind);
  try {
    await body(fixture);
  } finally {
    await fixture.close();
  }
}

async function rpc(
  fixture: Fixture,
  method: 'tools/call' | 'resources/read',
  name: string,
  params: Record<string, unknown>,
) {
  const response = await fixture.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': method,
        'Mcp-Name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: { ...params, _meta: ENVELOPE },
      }),
    }),
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  const payload = text.startsWith('event:')
    ? (text.split('\n').find((line) => line.startsWith('data: ')) ?? '').slice(6)
    : text;
  return JSON.parse(payload) as {
    result: { structuredContent?: unknown; contents?: { text: string }[] };
  };
}

for (const kind of ['local', 'projected'] as const) {
  describe(`source selector contract: ${kind}`, () => {
    it('reads the exact ID when it is also another artifact path', async () => {
      await withFixture(kind, async ({ runtime, buildId }) => {
        const read = await runtime.readSource({ artifactId: 'omega:z.md', buildId });
        expect(read.locator.artifactId).toBe('omega:z.md');
        expect(read.text).toContain('ID_TARGET_BODY');
        expect(read.text).not.toContain('PATH_TARGET_BODY');
        expect(read.buildId).toBe(buildId);
      });
    });
    it('reads the exact path when it is also another artifact ID', async () => {
      await withFixture(kind, async ({ runtime, buildId }) => {
        const read = await runtime.readSource({ path: 'omega:z.md', buildId });
        expect(read.locator.artifactId).toBe('alpha:omega:z.md');
        expect(read.text).toContain('PATH_TARGET_BODY');
        expect(read.text).not.toContain('ID_TARGET_BODY');
      });
    });
    it('refuses a duplicate source-relative path with a bounded explanation', async () => {
      await withFixture(kind, async ({ runtime, buildId }) => {
        await expect(runtime.readSource({ path: 'z.md', buildId })).rejects.toMatchObject({
          code: 'LORE_E_INVALID_ARGUMENT',
          details: { artifactIds: expect.any(Array) },
        });
        try {
          await runtime.readSource({ path: 'z.md', buildId });
        } catch (error) {
          expect(
            (error as { details: { artifactIds: string[] } }).details.artifactIds,
          ).toHaveLength(2);
        }
      });
    });
    it.each([{ artifactId: 'omega/z.md' }, { path: 'alpha:omega:z.md' }])(
      'does not use the other namespace for a miss %j',
      async (request) => {
        await withFixture(kind, async ({ runtime, buildId }) => {
          await expect(runtime.readSource({ ...request, buildId })).rejects.toMatchObject({
            code: 'LORE_E_BUILD_NOT_FOUND',
          });
        });
      },
    );
    it('reads the locator returned by search', async () => {
      await withFixture(kind, async ({ runtime, buildId }) => {
        const result = await runtime.search({
          query: 'ID_TARGET_BODY',
          limit: 10,
          includeArchived: false,
          debug: false,
          buildId,
        });
        const hit = result.hits.find((hit) => hit.artifactId === 'omega:z.md');
        expect(hit).toBeDefined();
        const read = await runtime.readSource({ artifactId: hit?.locator.artifactId, buildId });
        expect(read.locator.artifactId).toBe(hit?.locator.artifactId);
        expect(read.text).toContain('ID_TARGET_BODY');
      });
    });
    it('preserves ID meaning through HTTP and the actual SDK', async () => {
      await withFixture(kind, async (fixture) => {
        const client = new LoreClient({
          baseUrl: ORIGIN,
          buildId: fixture.buildId,
          fetch: async (input, init) => fixture.fetch(new Request(input, init)),
        });
        const read = await client.readSource('omega:z.md');
        expect(read.locator.artifactId).toBe('omega:z.md');
        expect(read.text).toContain('ID_TARGET_BODY');
        expect(read.buildId).toBe(fixture.buildId);
      });
    });
    it('preserves both MCP tool selectors and resource ID meaning', async () => {
      await withFixture(kind, async (fixture) => {
        for (const [request, id, marker] of [
          [{ artifactId: 'omega:z.md' }, 'omega:z.md', 'ID_TARGET_BODY'],
          [{ path: 'omega:z.md' }, 'alpha:omega:z.md', 'PATH_TARGET_BODY'],
        ] as const) {
          const frame = await rpc(fixture, 'tools/call', 'lore_read_source', {
            name: 'lore_read_source',
            arguments: { ...request, buildId: fixture.buildId },
          });
          const read = sourceReadResultSchema.parse(frame.result.structuredContent);
          expect(read.locator.artifactId).toBe(id);
          expect(read.text).toContain(marker);
        }
        for (const uri of [
          'lore://source/omega%3Az.md',
          `lore://build/${fixture.buildId}/source/omega%3Az.md`,
        ]) {
          const frame = await rpc(fixture, 'resources/read', uri, { uri });
          const read = sourceReadResultSchema.parse(
            JSON.parse(frame.result.contents?.[0]?.text ?? '{}'),
          );
          expect(read.locator.artifactId).toBe('omega:z.md');
          expect(read.text).toContain('ID_TARGET_BODY');
        }
      });
    });
  });
}

it('CLI inspection gives display paths priority and refuses ambiguous relative paths', async () => {
  await withFixture('local', async (fixture) => {
    const invoke = (args: string[]) => run(['--cwd', fixture.root, '--json', ...args]);
    const display = await invoke(['inspect', 'omega/z.md']);
    expect(display.code).toBe(0);
    expect(JSON.parse(display.stdout).artifact.id).toBe('omega:z.md');
    const alias = await invoke(['inspect', 'omega:z.md']);
    expect(alias.code).toBe(0);
    expect(JSON.parse(alias.stdout).artifact.id).toBe('alpha:omega:z.md');
    const id = await invoke(['inspect', 'alpha:omega:z.md']);
    expect(id.code).toBe(0);
    expect(JSON.parse(id.stdout).artifact.id).toBe('alpha:omega:z.md');
    for (const args of [
      ['inspect', 'z.md'],
      ['inspect', 'chunks', 'z.md'],
    ]) {
      const ambiguous = await invoke(args);
      expect(ambiguous.code).not.toBe(0);
      expect(JSON.parse(ambiguous.stdout)).toMatchObject({
        error: { code: 'LORE_E_INVALID_ARGUMENT' },
      });
    }
  });
});
