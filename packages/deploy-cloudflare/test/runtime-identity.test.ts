import type { BuildId } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import {
  createCloudflareDeploymentTarget,
  createCloudflareWorkerFromBindings,
  D1ActiveBuildProvider,
  hashRuntimeToken,
  storeRuntimeTokenHash,
} from '../src/index.js';
import { createProjectedWorkerRuntimeFixture, PROJECT } from './projected-runtime-fixture.js';

const CORPUS_ID = `corpus_${'c'.repeat(32)}`;
const OTHER_CORPUS = `corpus_${'e'.repeat(32)}`;

describe('runtime identity over real projection state (#697)', () => {
  it.each(['missing', 'malformed'])(
    'refuses %s binding without initializing it on a read',
    async (kind) => {
      const fixture = await createProjectedWorkerRuntimeFixture();
      const worker = createCloudflareWorkerFromBindings({
        CATALOG_DB: fixture.projection,
        TABLES_DB: fixture.projection,
        OBJECTS: fixture.bucket,
        PROJECT_ID: PROJECT,
      });
      try {
        if (kind === 'missing') fixture.projection.raw.exec('DELETE FROM runtime_identity');
        else fixture.projection.raw.exec("UPDATE runtime_identity SET namespace_id = 'invalid'");
        const before = fixture.projection.raw.prepare('SELECT * FROM runtime_identity').all();
        const response = await worker.fetch(new Request('https://worker.example/v1/build'));
        expect(response.status).toBe(500);
        expect(JSON.stringify(await response.json())).toContain('LORE_E_SCHEMA_MISMATCH');
        expect(fixture.projection.raw.prepare('SELECT * FROM runtime_identity').all()).toEqual(
          before,
        );
      } finally {
        worker.close();
        await fixture.close();
      }
    },
  );

  it('persists corpus identity and gives each deployment a distinct namespace', async () => {
    const first = await createProjectedWorkerRuntimeFixture();
    const second = await createProjectedWorkerRuntimeFixture();
    try {
      const a = await first.runtime.describeBuild();
      const b = await second.runtime.describeBuild();
      expect(a.buildId).toBe(b.buildId);
      expect(a.corpusId).toBe(CORPUS_ID);
      expect(b.corpusId).toBe(CORPUS_ID);
      expect(a.namespaceId).toMatch(/^namespace_[0-9a-f]{32}$/);
      expect(a.namespaceId).not.toBe(b.namespaceId);
      const reopened = new D1ActiveBuildProvider(first.projection, PROJECT);
      const other = new D1ActiveBuildProvider(first.projection, PROJECT);
      const handle = await reopened.acquire();
      const foreign = await other.acquire();
      try {
        expect(handle.corpusId).toBe(a.corpusId);
        expect(handle.namespaceId).toBe(a.namespaceId);
        expect(() => reopened.assertHandle(foreign)).toThrowError(/foreign/);
        expect(() => reopened.assertHandle({ ...handle })).toThrowError(/forged/);
        expect(() => reopened.assertHandle(handle)).not.toThrow();
        handle.release();
        expect(() => reopened.assertHandle(handle)).toThrowError(/released/);
      } finally {
        handle.release();
        foreign.release();
      }
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('refuses another corpus before planning, projecting or rolling back', async () => {
    const fixture = await createProjectedWorkerRuntimeFixture();
    try {
      const active = await fixture.runtime.describeBuild();
      const common = {
        projectId: PROJECT,
        endpoint: 'https://worker.example/mcp',
        catalogDb: fixture.projection,
        objects: fixture.bucket,
      };
      const own = createCloudflareDeploymentTarget({ ...common, corpusId: CORPUS_ID });
      const foreign = createCloudflareDeploymentTarget({ ...common, corpusId: OTHER_CORPUS });
      const input = {
        corpusId: CORPUS_ID,
        projectName: 'renamed display label',
        buildId: active.buildId as BuildId,
        buildDirectory: fixture.buildDirectory,
        buildCapabilities: active.capabilities,
      };
      const plan = await own.plan(input);
      const binding = fixture.projection.raw.prepare('SELECT * FROM runtime_identity').all();
      const changes = fixture.projection.raw.prepare('SELECT total_changes() AS n').get();
      await expect(foreign.plan({ ...input, corpusId: OTHER_CORPUS })).rejects.toMatchObject({
        code: 'LORE_E_INVALID_ARGUMENT',
      });
      expect(fixture.projection.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
      await expect(
        foreign.apply({ ...plan, input: { ...input, corpusId: OTHER_CORPUS } }),
      ).rejects.toMatchObject({
        cause: { code: 'LORE_E_INVALID_ARGUMENT' },
      });
      await expect(foreign.rollback(active.buildId)).rejects.toMatchObject({
        code: 'LORE_E_INVALID_ARGUMENT',
      });
      expect(fixture.projection.raw.prepare('SELECT * FROM runtime_identity').all()).toEqual(
        binding,
      );
      expect((await fixture.runtime.describeBuild()).buildId).toBe(active.buildId);
    } finally {
      await fixture.close();
    }
  });

  it('rejects a token from another deployment and a wrong configured project', async () => {
    const first = await createProjectedWorkerRuntimeFixture();
    const second = await createProjectedWorkerRuntimeFixture();
    const workers: ReturnType<typeof createCloudflareWorkerFromBindings>[] = [];
    try {
      const token = 'lore_rt_first_namespace_test';
      await storeRuntimeTokenHash(
        first.projection,
        await hashRuntimeToken(token),
        '2026-10-11T12:00:00Z',
      );
      await storeRuntimeTokenHash(
        second.projection,
        await hashRuntimeToken('lore_rt_second_namespace_test'),
        '2026-10-11T12:00:00Z',
      );
      for (const [fixture, projectId] of [
        [first, PROJECT],
        [second, PROJECT],
        [first, 'another-project'],
      ] as const) {
        workers.push(
          createCloudflareWorkerFromBindings(
            {
              CATALOG_DB: fixture.projection,
              TABLES_DB: fixture.projection,
              OBJECTS: fixture.bucket,
              PROJECT_ID: projectId,
            },
            { authMode: 'runtime-token' },
          ),
        );
      }
      const request = () =>
        new Request('https://worker.example/v1/build', {
          headers: { Authorization: `Bearer ${token}` },
        });
      const own = await workers[0]?.fetch(request());
      expect(own?.status).toBe(200);
      expect(await own?.json()).toMatchObject({
        corpusId: CORPUS_ID,
        namespaceId: expect.stringMatching(/^namespace_/),
      });
      const wrongToken = await workers[1]?.fetch(request());
      expect(wrongToken?.status).toBe(401);
      const wrongProject = await workers[2]?.fetch(request());
      expect(wrongProject?.status).toBe(400);
      expect(JSON.stringify(await wrongProject?.json())).toContain('LORE_E_INVALID_ARGUMENT');
    } finally {
      for (const worker of workers) worker.close();
      await first.close();
      await second.close();
    }
  });
});
