import { expect, it } from 'vitest';
import { applyRemoteRetentionPlan, planRemoteRetention } from '../src/retention.js';
import { createCloudflareDeploymentTarget } from '../src/target.js';
import {
  ACTIVE_BUILD,
  activateProjectedWorkerRuntimeFixture,
  CANDIDATE_BUILD,
  CORPUS_ID,
  createProjectedWorkerRuntimeFixture,
  PROJECT,
} from './projected-runtime-fixture.js';

it('refuses rollback after actual cleanup claims A before deleting it, issue439', async () => {
  const fixture = await createProjectedWorkerRuntimeFixture();
  let resume: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let ready: () => void = () => {};
  const claimed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const prepare = fixture.projection.prepare.bind(fixture.projection);
  fixture.projection.prepare = (query) => {
    const statement = prepare(query);
    const run = statement.run.bind(statement);
    statement.run = async <T = Record<string, unknown>>() => {
      if (query.startsWith('SELECT build_id AS buildId FROM retention_claims')) {
        ready();
        await barrier;
      }
      return await run<T>();
    };
    return statement;
  };
  const target = createCloudflareDeploymentTarget({
    corpusId: CORPUS_ID,
    projectId: PROJECT,
    endpoint: null,
    catalogDb: fixture.projection,
    objects: fixture.bucket,
  });
  let cleanup: ReturnType<typeof applyRemoteRetentionPlan> | undefined;
  try {
    await activateProjectedWorkerRuntimeFixture();
    const preview = await planRemoteRetention(fixture.projection, fixture.projection, PROJECT, 0);
    cleanup = applyRemoteRetentionPlan(
      fixture.projection,
      fixture.projection,
      fixture.bucket,
      preview,
    );
    await claimed;
    await expect(target.rollback(ACTIVE_BUILD)).rejects.toMatchObject({
      code: 'LORE_E_REMOTE_DEPLOY',
      details: { reason: 'retention-claimed' },
    });
    expect(
      (await fixture.runtime.readSource({ artifactId: fixture.knownArtifactId })).buildId,
    ).toBe(CANDIDATE_BUILD);
    resume();
    expect((await cleanup).remove).toContain(ACTIVE_BUILD);
    await expect(
      fixture.runtime.readSource({ buildId: ACTIVE_BUILD, artifactId: fixture.knownArtifactId }),
    ).rejects.toMatchObject({ code: 'LORE_E_BUILD_NOT_FOUND' });
  } finally {
    resume();
    await cleanup;
    await fixture.close();
  }
});
