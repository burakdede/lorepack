import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { type BuildId, loadConfig, ProgressBus } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { startServing } from '../src/services/serving.js';

async function retainedPair(
  body: (
    backend: ReturnType<typeof createLocalRuntimeBackend>,
    first: BuildId,
    second: BuildId,
    root: string,
  ) => Promise<void>,
) {
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: selected\nsources:\n  - docs\n',
        'docs/guide.md': '# Rollback\n\nRollback uses the original checkpoint.\n',
        'docs/pricing.csv': 'sku,price\nA-1,10\n',
      },
    },
    async (project) => {
      const build = () =>
        runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
      const first = (await build()).buildId;
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      const held = await backend.provider.acquire();
      try {
        writeFileSync(
          join(project.root, 'docs/guide.md'),
          '# Rollback\n\nRollback uses the replacement worker.\n',
        );
        writeFileSync(join(project.root, 'docs/pricing.csv'), 'sku,price\nA-1,20\n');
        const second = (await build()).buildId;
        expect(second).not.toBe(first);
        expect(held.buildId).toBe(first);
        await body(backend, first, second, project.root);
      } finally {
        held.release();
        backend.close();
      }
    },
  );
}

describe('exact retained-build selection, issue432', () => {
  it('reads retained A and starts its selected server without an active pointer', async () => {
    await retainedPair(async (backend, first, _second, root) => {
      const state = new DatabaseSync(join(root, '.lore/state.sqlite'));
      try {
        state.exec('UPDATE active_build SET build_id = NULL WHERE id = 1');
      } finally {
        state.close();
      }
      expect((await createRuntime(backend).describeBuild({ buildId: first })).buildId).toBe(first);
      await expect(backend.provider.acquire()).rejects.toMatchObject({
        code: 'LORE_E_BUILD_NOT_FOUND',
      });
      const server = await startServing({
        config: loadConfig({ cwd: root }),
        buildId: first,
        host: '127.0.0.1',
        port: 43_833,
        warn: () => {},
      });
      try {
        expect(await (await fetch(`${server.url}/v1/build`)).json()).toMatchObject({
          buildId: first,
        });
      } finally {
        await server.close();
      }
    });
  });

  it('refuses a missing catalog with a retained record, including a live POSIX handle', async () => {
    await retainedPair(async (backend, first, _second, root) => {
      const catalog = join(root, '.lore/builds', first, 'context.sqlite');
      if (process.platform === 'win32') {
        expect(() => rmSync(catalog)).toThrow(expect.objectContaining({ code: 'EPERM' }));
        backend.provider.closeAll();
      }
      rmSync(catalog);
      await expect(backend.provider.acquire({ buildId: first })).rejects.toMatchObject({
        code: 'LORE_E_BUILD_NOT_FOUND',
      });
    });
  });

  it('refuses an unregistered retained build even while an owned catalog handle exists', async () => {
    await retainedPair(async (backend, first, second, root) => {
      const state = new DatabaseSync(join(root, '.lore/state.sqlite'));
      try {
        state.prepare('DELETE FROM builds WHERE build_id = ?').run(first);
      } finally {
        state.close();
      }
      await expect(backend.provider.acquire({ buildId: first })).rejects.toMatchObject({
        code: 'LORE_E_BUILD_NOT_FOUND',
      });
      expect((await createRuntime(backend).describeBuild()).buildId).toBe(second);
    });
  });

  it('rejects malformed or abbreviated selections before looking up retained files', async () => {
    await retainedPair(async (backend, first) => {
      for (const buildId of [
        '../context.sqlite',
        first.slice(0, 17),
        `lore_${'a'.repeat(63)}`,
        `${first}/context.sqlite`,
      ]) {
        await expect(backend.provider.acquire({ buildId })).rejects.toMatchObject({
          code: 'LORE_E_INVALID_ARGUMENT',
        });
      }
    });
  });
  it('keeps 200 context requests and all text and table reads on A after B activates', async () => {
    await retainedPair(async (backend, first) => {
      const runtime = createRuntime({ ...backend, buildId: first, freshness: async () => 'clean' });
      for (let index = 0; index < 200; index += 1) {
        const bundle = await runtime.contextForTask({
          task: 'rollback',
          includeArchived: false,
          allowUnsupportedBudget: false,
        });
        expect(bundle.buildId).toBe(first);
        expect(bundle.sourceState).toBe('unknown');
        const encoded = JSON.stringify(bundle);
        expect(encoded).toContain('original checkpoint');
        expect(encoded).not.toContain('replacement worker');
      }
      const search = await runtime.search({
        query: 'rollback',
        limit: 10,
        includeArchived: false,
        debug: false,
      });
      const artifactId = search.hits[0]?.artifactId;
      expect(artifactId).toBeDefined();
      const source = await runtime.readSource({ artifactId: artifactId as string });
      expect(source.buildId).toBe(first);
      expect(JSON.stringify(source)).toContain('original checkpoint');
      const table = (await runtime.listTables())[0];
      expect(table).toBeDefined();
      const described = await runtime.describeTable(table?.tableId as string);
      expect(described.buildId).toBe(first);
      const rows = await runtime.queryTable({
        tableId: described.tableId,
        sql: `SELECT ${described.columns.map((column) => column.sqlName).join(', ')} FROM ${described.sqlName}`,
      });
      expect(rows.buildId).toBe(first);
      expect(rows.rows[0]).toMatchObject({ price: 10 });
    });
  });

  it('serves selected A through HTTP, Studio metadata, MCP tools and resources', async () => {
    await retainedPair(async (_backend, first, second, root) => {
      const server = await startServing({
        config: loadConfig({ cwd: root }),
        buildId: first,
        host: '127.0.0.1',
        port: 43_832,
        warn: () => {},
      });
      try {
        for (const path of ['/v1/build', '/v1/sources', '/v1/warnings', '/health']) {
          const reply = await fetch(`${server.url}${path}`);
          expect(reply.status).toBe(200);
          expect(await reply.json()).toMatchObject({ buildId: first });
        }
        const refused = await fetch(`${server.url}/v1/build?buildId=${second}`);
        expect(refused.status).toBe(400);
        for (const [method, params] of [
          ['tools/call', { name: 'lore_build_info', arguments: {} }],
          ['tools/call', { name: 'lore_search', arguments: { query: 'rollback', buildId: first } }],
          ['resources/read', { uri: 'lore://project/build' }],
          ['resources/read', { uri: `lore://build/${first}` }],
          ['resources/read', { uri: `lore://build/${first}/tables` }],
        ] as const) {
          const reply = await fetch(`${server.url}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          });
          expect(reply.status).toBe(200);
          const text = await reply.text();
          expect(text).toContain(first);
          expect(text).not.toContain(second);
          expect(text).not.toContain('replacement worker');
        }
      } finally {
        await server.close();
      }
    });
  });

  it('rejects attempts to override a server selection', async () => {
    await retainedPair(async (backend, first, second) => {
      const runtime = createRuntime({ ...backend, buildId: first });
      await expect(runtime.describeBuild({ buildId: second })).rejects.toMatchObject({
        code: 'LORE_E_INVALID_ARGUMENT',
      });
    });
  });
  it('acquires A after controlled activation of B without falling back', async () => {
    await retainedPair(async (backend, first, second) => {
      const acquire = backend.provider.acquire.bind(backend.provider);
      const pinned = await acquire({ buildId: first });
      const active = await acquire();
      try {
        expect(pinned.buildId).toBe(first);
        expect(active.buildId).toBe(second);
        const scope = await backend.open(pinned);
        expect(scope.buildId).toBe(first);
        expect((await scope.catalog.search('checkpoint', { limit: 10 })).length).toBeGreaterThan(0);
      } finally {
        pinned.release();
        active.release();
      }
    });
  });

  it('refuses an unavailable selected build while B remains available', async () => {
    await retainedPair(async (backend, _first, second) => {
      const acquire = backend.provider.acquire.bind(backend.provider);
      const missing = `lore_${'0'.repeat(64)}` as BuildId;
      await expect(acquire({ buildId: missing })).rejects.toMatchObject({
        code: 'LORE_E_BUILD_NOT_FOUND',
      });
      const active = await acquire();
      try {
        expect(active.buildId).toBe(second);
      } finally {
        active.release();
      }
    });
  });

  it('carries selected A through the shared runtime search boundary', async () => {
    await retainedPair(async (backend, first, second) => {
      const runtime = createRuntime(backend);
      const request = {
        query: 'rollback',
        limit: 10,
        includeArchived: false,
        debug: false,
        buildId: first,
      };
      const result = await runtime.search(request);
      expect(result.buildId).toBe(first);
      expect(result.hits.some((hit) => hit.excerpt.includes('original checkpoint'))).toBe(true);
      expect(result.hits.every((hit) => !hit.excerpt.includes('replacement worker'))).toBe(true);
      expect(
        (
          await runtime.search({
            query: 'rollback',
            limit: 10,
            includeArchived: false,
            debug: false,
          })
        ).buildId,
      ).toBe(second);
    });
  });
});
