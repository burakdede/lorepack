import { type BuildId, type BuildScope, LoreError } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { expect, it } from 'vitest';
import { D1CatalogStore } from '../src/catalog.js';
import { acquireRemoteMutationGuard } from '../src/mutation_ownership.js';
import {
  applyRemoteRetention,
  applyRemoteRetentionPlan,
  planRemoteRetention,
  RemoteRetentionApplyError,
} from '../src/retention.js';
import { D1ActiveBuildProvider, R2ObjectStore } from '../src/storage.js';
import { D1TableStore } from '../src/tables.js';
import {
  ACTIVE_BUILD,
  activateProjectedWorkerRuntimeFixture,
  CANDIDATE_BUILD,
  createProjectedWorkerRuntimeFixture,
  PROJECT,
} from './projected-runtime-fixture.js';

it('keeps200 acquired remote A reads intact while B activates and another provider prunes, issue439', async () => {
  const fixture = await createProjectedWorkerRuntimeFixture();
  let resume: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let ready: () => void = () => {};
  const allAcquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let acquired = 0;
  const provider = new D1ActiveBuildProvider(fixture.projection, PROJECT);
  const runtime = createRuntime({
    provider,
    open: async (handle): Promise<BuildScope> => {
      acquired += 1;
      if (acquired === 200) ready();
      await barrier;
      return {
        corpusId: handle.corpusId,
        namespaceId: handle.namespaceId,
        buildId: handle.buildId,
        catalog: new D1CatalogStore({
          db: fixture.projection,
          namespace: { projectId: PROJECT, buildId: handle.buildId },
        }),
        tables: new D1TableStore(fixture.projection, {
          projectId: PROJECT,
          buildId: handle.buildId,
        }),
        objects: new R2ObjectStore(PROJECT, fixture.bucket),
      };
    },
  });
  const reads: Promise<unknown>[] = [];
  try {
    const control = await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId });
    expect(control.buildId).toBe(ACTIVE_BUILD);
    expect(JSON.stringify(control)).toContain(
      'To roll back a release, activate the previous build.',
    );
    for (let index = 0; index < 200; index += 1) {
      reads.push(runtime.readSource({ artifactId: fixture.knownArtifactId }));
    }
    const settled = Promise.allSettled(reads);
    await allAcquired;
    await activateProjectedWorkerRuntimeFixture();
    const cleanup = await applyRemoteRetention(
      fixture.projection,
      fixture.projection,
      fixture.bucket,
      PROJECT,
      0,
    );
    const active = await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId });
    expect(active.buildId).toBe(CANDIDATE_BUILD);
    expect(JSON.stringify(active)).toContain('tell the team what changed');
    resume();
    const results = await settled;
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0);
    expect(cleanup.remove).not.toContain(ACTIVE_BUILD);
    for (const result of results) {
      if (result.status !== 'fulfilled') throw result.reason;
      expect(JSON.stringify(result.value)).toContain(ACTIVE_BUILD);
      expect(JSON.stringify(result.value)).toContain(
        'To roll back a release, activate the previous build.',
      );
      expect(JSON.stringify(result.value)).not.toContain('tell the team what changed');
    }
  } finally {
    resume();
    await Promise.allSettled(reads);
    await fixture.close();
  }
});

it('reconciles a remote cleanup preview after an exact A owner registers, issue439', async () => {
  const fixture = await createProjectedWorkerRuntimeFixture();
  const provider = new D1ActiveBuildProvider(fixture.projection, PROJECT);
  let handle: Awaited<ReturnType<typeof provider.acquire>> | undefined;
  try {
    await activateProjectedWorkerRuntimeFixture();
    const preview = await planRemoteRetention(fixture.projection, fixture.projection, PROJECT, 0);
    expect(preview.remove).toContain(ACTIVE_BUILD);
    handle = await provider.acquire({ buildId: ACTIVE_BUILD });
    const applied = await applyRemoteRetentionPlan(
      fixture.projection,
      fixture.projection,
      fixture.bucket,
      preview,
    );
    expect(applied.remove).not.toContain(ACTIVE_BUILD);
    const retained = await fixture.runtime.readSource({
      buildId: ACTIVE_BUILD,
      artifactId: fixture.knownArtifactId,
    });
    expect(retained.buildId).toBe(ACTIVE_BUILD);
    expect(JSON.stringify(retained)).toContain(
      'To roll back a release, activate the previous build.',
    );
    await handle.release();
    const afterRelease = await applyRemoteRetention(
      fixture.projection,
      fixture.projection,
      fixture.bucket,
      PROJECT,
      0,
    );
    expect(afterRelease.remove).toContain(ACTIVE_BUILD);
    expect(
      (await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId })).buildId,
    ).toBe(CANDIDATE_BUILD);
  } finally {
    await handle?.release();
    await fixture.close();
  }
});

it('fences a materialized remote result whose ownership expired, and awaits release, issue439', async () => {
  const fixture = await createProjectedWorkerRuntimeFixture();
  let materializedBodies = 0;
  const get = fixture.bucket.get.bind(fixture.bucket);
  fixture.bucket.get = async (key) => {
    const body = await get(key);
    if (body === null) return null;
    return {
      arrayBuffer: async () => {
        const bytes = await body.arrayBuffer();
        materializedBodies += 1;
        return bytes;
      },
    };
  };
  const provider = new D1ActiveBuildProvider(fixture.projection, PROJECT);
  const runtime = createRuntime({
    provider,
    open: async (handle): Promise<BuildScope> => {
      fixture.projection.raw
        .prepare(
          "UPDATE runtime_read_owners SET expires_at = unixepoch('now') - 1 WHERE build_id = ?",
        )
        .run(handle.buildId);
      return {
        corpusId: handle.corpusId,
        namespaceId: handle.namespaceId,
        buildId: handle.buildId,
        catalog: new D1CatalogStore({
          db: fixture.projection,
          namespace: { projectId: PROJECT, buildId: handle.buildId },
        }),
        tables: new D1TableStore(fixture.projection, {
          projectId: PROJECT,
          buildId: handle.buildId,
        }),
        objects: new R2ObjectStore(PROJECT, fixture.bucket),
      };
    },
  });
  try {
    await expect(runtime.readSource({ artifactId: fixture.knownArtifactId })).rejects.toMatchObject(
      {
        code: 'LORE_E_LIMIT_EXCEEDED',
        details: { reason: 'remote-read-expired' },
      },
    );
    expect(materializedBodies).toBe(1);
    expect(
      fixture.projection.raw.prepare('SELECT count(*) AS count FROM runtime_read_owners').get(),
    ).toMatchObject({ count: 0 });
    const result = await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId });
    expect(result.buildId).toBe(ACTIVE_BUILD);
    expect(
      fixture.projection.raw.prepare('SELECT count(*) AS count FROM runtime_read_owners').get(),
    ).toMatchObject({ count: 0 });
  } finally {
    await fixture.close();
  }
});

it('refuses cleanup while a real candidate apply owns its partial projection, issue439', async () => {
  const fixture = await createProjectedWorkerRuntimeFixture();
  let resume: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let ready: () => void = () => {};
  const projecting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const get = fixture.bucket.head.bind(fixture.bucket);
  let paused = false;
  fixture.bucket.head = async (key) => {
    if (!paused && key.includes(`/builds/${CANDIDATE_BUILD}/`)) {
      paused = true;
      ready();
      await barrier;
    }
    return await get(key);
  };
  let apply: ReturnType<typeof fixture.target.apply> | undefined;
  try {
    const plan = await fixture.target.plan({
      corpusId: `corpus_${'c'.repeat(32)}`,
      projectName: PROJECT,
      buildId: CANDIDATE_BUILD,
      buildDirectory: fixture.candidateDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'],
    });
    apply = fixture.target.apply(plan);
    await Promise.race([
      projecting,
      apply.then(() => {
        throw new Error('Candidate apply finished before the projection barrier.');
      }),
    ]);
    await expect(
      applyRemoteRetention(fixture.projection, fixture.projection, fixture.bucket, PROJECT, 0),
    ).rejects.toMatchObject({
      code: 'LORE_E_REMOTE_DEPLOY',
      details: { reason: 'remote-mutation-owned' },
    });
    await expect(fixture.target.rollback(CANDIDATE_BUILD)).rejects.toMatchObject({
      code: 'LORE_E_REMOTE_DEPLOY',
      details: { reason: 'remote-build-owned' },
    });
    expect(
      (await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId })).buildId,
    ).toBe(ACTIVE_BUILD);
    resume();
    const receipt = await apply;
    expect(await fixture.target.verify(receipt)).toMatchObject({
      search: 'passed',
      sourceRead: 'passed',
    });
    await fixture.target.activate(receipt);
    expect(
      (await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId })).buildId,
    ).toBe(CANDIDATE_BUILD);
  } finally {
    resume();
    await apply;
    await fixture.close();
  }
});

it('reuses verified A without invalidating its live table reads during redeployment, issue439', async () => {
  const fixture = await createProjectedWorkerRuntimeFixture();
  const provider = new D1ActiveBuildProvider(fixture.projection, PROJECT);
  const handle = await provider.acquire({ buildId: ACTIVE_BUILD });
  let resume: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let ready: () => void = () => {};
  const dropped = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const prepare = fixture.projection.prepare.bind(fixture.projection);
  let drops = 0;
  fixture.projection.prepare = (query) => {
    const statement = prepare(query);
    const run = statement.run.bind(statement);
    statement.run = async <T = Record<string, unknown>>() => {
      const result = await run<T>();
      if (query.startsWith('DROP TABLE IF EXISTS')) {
        drops += 1;
        ready();
        await barrier;
      }
      return result;
    };
    return statement;
  };
  let apply: ReturnType<typeof fixture.target.apply> | undefined;
  try {
    const table = await fixture.runtime.describeTable(fixture.knownTableId);
    const sql = `SELECT ${table.columns[0]?.sqlName} FROM ${table.sqlName} LIMIT 1`;
    const control = await fixture.runtime.queryTable({ tableId: fixture.knownTableId, sql });
    const plan = await fixture.target.plan({
      corpusId: `corpus_${'c'.repeat(32)}`,
      projectName: PROJECT,
      buildId: ACTIVE_BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'],
    });
    apply = fixture.target.apply(plan);
    await Promise.race([dropped, apply]);
    await expect(
      fixture.runtime.queryTable({ tableId: fixture.knownTableId, sql }),
    ).resolves.toEqual(control);
    resume();
    await apply;
    expect(drops).toBe(0);
    expect(
      (await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId })).buildId,
    ).toBe(ACTIVE_BUILD);
  } finally {
    resume();
    await apply;
    await handle.release();
    await fixture.close();
  }
});

it('rechecks shared object references before resuming an interrupted remote cleanup, issue439', async () => {
  const fixture = await createProjectedWorkerRuntimeFixture();
  const buildC = `lore_${'d'.repeat(64)}` as BuildId;
  const remove = fixture.bucket.delete?.bind(fixture.bucket);
  if (remove === undefined) throw new Error('Fixture must support real object deletion.');
  let failed: RemoteRetentionApplyError | undefined;
  try {
    await activateProjectedWorkerRuntimeFixture();
    const preview = await planRemoteRetention(fixture.projection, fixture.projection, PROJECT, 0);
    expect(preview.objectKeysToRemove.length).toBeGreaterThan(0);
    const interruptedKey = preview.objectKeysToRemove[0];
    fixture.bucket.delete = async (key) => {
      if (key === interruptedKey) throw new Error('Injected R2 deletion failure.');
      await remove(key);
    };
    try {
      await applyRemoteRetentionPlan(
        fixture.projection,
        fixture.projection,
        fixture.bucket,
        preview,
      );
    } catch (error) {
      if (!(error instanceof RemoteRetentionApplyError)) throw error;
      failed = error;
    }
    if (failed === undefined) throw new Error('The injected deletion failure was not exercised.');
    expect(failed.progress.d1Completed).toBe(true);
    fixture.bucket.delete = remove;
    const receipt = await fixture.applySharedCandidate(buildC);
    expect(await fixture.target.verify(receipt)).toMatchObject({
      search: 'passed',
      sourceRead: 'passed',
    });
    const control = await fixture.runtime.readSource({
      buildId: buildC,
      artifactId: fixture.knownArtifactId,
    });
    const resumed = await applyRemoteRetentionPlan(
      fixture.projection,
      fixture.projection,
      fixture.bucket,
      preview,
      failed.progress,
    );
    await expect(
      fixture.runtime.readSource({ buildId: buildC, artifactId: fixture.knownArtifactId }),
    ).resolves.toEqual(control);
    expect(resumed.r2.objectKeysRemoved).not.toContain(interruptedKey);
    expect(
      (await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId })).buildId,
    ).toBe(CANDIDATE_BUILD);
  } finally {
    fixture.bucket.delete = remove;
    await fixture.close();
  }
});

it('reclaims expired remote read records while refusing late owner completion, issue439', async () => {
  const fixture = await createProjectedWorkerRuntimeFixture();
  const provider = new D1ActiveBuildProvider(fixture.projection, PROJECT);
  const handle = await provider.acquire({ buildId: ACTIVE_BUILD });
  try {
    fixture.projection.raw
      .prepare("UPDATE runtime_read_owners SET expires_at = unixepoch('now') - 1")
      .run();
    await activateProjectedWorkerRuntimeFixture();
    const cleanup = await applyRemoteRetention(
      fixture.projection,
      fixture.projection,
      fixture.bucket,
      PROJECT,
      0,
    );
    expect(cleanup.remove).toContain(ACTIVE_BUILD);
    expect(
      fixture.projection.raw.prepare('SELECT count(*) AS count FROM runtime_read_owners').get(),
    ).toMatchObject({ count: 0 });
    await expect(handle.release()).rejects.toMatchObject({
      code: 'LORE_E_LIMIT_EXCEEDED',
      details: { reason: 'remote-read-expired' },
    });
    expect(
      (await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId })).buildId,
    ).toBe(CANDIDATE_BUILD);
  } finally {
    await handle.release().catch(() => {});
    await fixture.close();
  }
});

it('preserves ambiguous mutation ownership regardless of age and releases only its capability, issue439', async () => {
  const fixture = await createProjectedWorkerRuntimeFixture();
  const owner = await acquireRemoteMutationGuard(fixture.projection, {
    kind: 'apply',
    projectId: PROJECT,
    buildId: CANDIDATE_BUILD,
  });
  try {
    fixture.projection.raw
      .prepare("UPDATE remote_mutation_guard SET started_at = '2000-01-01T00:00:00Z'")
      .run();
    await expect(
      applyRemoteRetention(fixture.projection, fixture.projection, fixture.bucket, PROJECT, 0),
    ).rejects.toMatchObject({
      code: 'LORE_E_REMOTE_DEPLOY',
      details: { reason: 'remote-mutation-owned' },
    });
    expect(
      (await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId })).buildId,
    ).toBe(ACTIVE_BUILD);
    await owner.release();
    await owner.release();
    expect(
      fixture.projection.raw.prepare('SELECT count(*) AS count FROM remote_mutation_guard').get(),
    ).toMatchObject({ count: 0 });
    await applyRemoteRetention(fixture.projection, fixture.projection, fixture.bucket, PROJECT, 0);
  } finally {
    await owner.release();
    await fixture.close();
  }
});

it('preserves mutation ownership when remote completion is unknown after cleanup failure, issue439', async () => {
  const fixture = await createProjectedWorkerRuntimeFixture();
  const remove = fixture.bucket.delete?.bind(fixture.bucket);
  if (remove === undefined) throw new Error('Fixture must support real deletion.');
  try {
    await activateProjectedWorkerRuntimeFixture();
    const preview = await planRemoteRetention(fixture.projection, fixture.projection, PROJECT, 0);
    fixture.bucket.delete = async (key) => {
      await remove(key);
      throw new LoreError('LORE_E_REMOTE_DEPLOY', 'Remote completion was not confirmed.', {
        details: { reason: 'remote-mutation-completion-unknown' },
      });
    };
    await expect(
      applyRemoteRetention(fixture.projection, fixture.projection, fixture.bucket, PROJECT, 0),
    ).rejects.toBeInstanceOf(RemoteRetentionApplyError);
    expect(
      fixture.projection.raw.prepare('SELECT count(*) AS count FROM remote_mutation_guard').get(),
    ).toMatchObject({ count: 1 });
    fixture.bucket.delete = remove;
    await expect(
      applyRemoteRetentionPlan(fixture.projection, fixture.projection, fixture.bucket, preview),
    ).rejects.toMatchObject({
      code: 'LORE_E_REMOTE_DEPLOY',
      details: { reason: 'remote-mutation-owned' },
    });
    expect(
      (await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId })).buildId,
    ).toBe(CANDIDATE_BUILD);
  } finally {
    fixture.bucket.delete = remove;
    await fixture.close();
  }
});

it('upgrades operational ownership for a resumed receipt whose previous migrations completed, issue439', async () => {
  const fixture = await createProjectedWorkerRuntimeFixture();
  try {
    fixture.projection.raw.prepare('DROP TABLE remote_mutation_guard').run();
    fixture.projection.raw.prepare("DELETE FROM schema_migrations WHERE id = '0007'").run();
    const plan = await fixture.target.plan({
      corpusId: `corpus_${'c'.repeat(32)}`,
      projectName: PROJECT,
      buildId: CANDIDATE_BUILD,
      buildDirectory: fixture.candidateDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'],
    });
    await expect(fixture.target.apply(plan, fixture.candidateReceipt)).resolves.toMatchObject({
      buildId: CANDIDATE_BUILD,
      transfer: { state: { migrations_done: true } },
    });
    expect(
      fixture.projection.raw.prepare("SELECT id FROM schema_migrations WHERE id = '0007'").get(),
    ).toMatchObject({ id: '0007' });
    expect(await fixture.target.verify(fixture.candidateReceipt)).toMatchObject({
      search: 'passed',
      sourceRead: 'passed',
    });
    expect(
      (await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId })).buildId,
    ).toBe(ACTIVE_BUILD);
  } finally {
    await fixture.close();
  }
});
