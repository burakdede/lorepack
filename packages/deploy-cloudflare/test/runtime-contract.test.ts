import { escapeFtsQuery, NATIVE_UNIT_LIMITS } from '@lorepack/core';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { type ContractFixture, runRuntimeContract } from '../../../tools/test-support/src/index.ts';
import { D1CatalogStore } from '../src/catalog.js';
import {
  ACTIVE_BUILD,
  activateProjectedWorkerRuntimeFixture,
  createProjectedWorkerRuntimeFixture,
  createProjectedWorkerRuntimeSources,
  PROJECT,
  type ProjectedWorkerRuntimeSources,
} from './projected-runtime-fixture.js';

let contractSources: ProjectedWorkerRuntimeSources;

beforeAll(() => {
  contractSources = createProjectedWorkerRuntimeSources();
});

afterAll(() => {
  contractSources.close();
});

runRuntimeContract({
  sqlProfile: 'remote',
  name: 'Cloudflare projected SQLite and object ports',
  create: async (hooks): Promise<ContractFixture> =>
    await createProjectedWorkerRuntimeFixture(hooks, contractSources),
  activateAnother: async (): Promise<string> => await activateProjectedWorkerRuntimeFixture(),
});

it('shares immutable source builds while keeping projected state isolated', async () => {
  const first = await createProjectedWorkerRuntimeFixture({}, contractSources);
  const second = await createProjectedWorkerRuntimeFixture({}, contractSources);
  try {
    expect(second.buildDirectory).toBe(first.buildDirectory);
    expect(second.candidateDirectory).toBe(first.candidateDirectory);
    expect(second.projection).not.toBe(first.projection);
    expect(second.bucket).not.toBe(first.bucket);

    await second.target.verify(second.candidateReceipt);
    expect(await first.runtime.describeBuild()).toMatchObject({
      buildId: ACTIVE_BUILD,
      sourceState: 'clean',
    });
  } finally {
    await first.close();
    await second.close();
  }
});

it('closes native qualifications from retained A after B activation in the real projection, issue698', async () => {
  const qualification =
    'Rollback is permitted only if owner approval is recorded; do not waive approval.';
  const nativeText = `Rollback is permitted. ${'Review operational conditions carefully. '.repeat(120)}${qualification}`;
  const fixture = await createProjectedWorkerRuntimeFixture({
    nativeText,
    chunkText: 'Rollback is permitted.',
  });
  try {
    const buildId = (await fixture.runtime.describeBuild()).buildId;
    await fixture.target.verify(fixture.candidateReceipt);
    await fixture.target.activate(fixture.candidateReceipt);
    const bundle = await fixture.runtime.contextForTask({
      task: 'rollback permitted',
      includeArchived: false,
      allowUnsupportedBudget: false,
      budget: 8000,
      buildId,
    });
    const items = [...bundle.overview, ...bundle.selected];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.text).toContain(nativeText);
      expect(item.text).toContain(qualification);
      expect(item.nativeUnit).toEqual({ nodeIds: ['n0'], status: 'complete' });
    }
    expect(bundle.buildId).toBe(buildId);
  } finally {
    await fixture.close();
  }
});

it('omits oversized projected units instead of returning their permission fragments, issue698', async () => {
  const fixture = await createProjectedWorkerRuntimeFixture({
    nativeText: `Rollback permitted ${'x'.repeat(NATIVE_UNIT_LIMITS.maxUtf8Bytes)}`,
    chunkText: 'Rollback permitted',
  });
  try {
    const bundle = await fixture.runtime.contextForTask({
      task: 'rollback permitted',
      includeArchived: false,
      allowUnsupportedBudget: false,
      budget: 8000,
    });
    expect([...bundle.overview, ...bundle.selected, ...bundle.alternatives]).toEqual([]);
    expect(bundle.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'structural-unit',
          nativeUnit: { nodeIds: ['n0'], status: 'omitted' },
        }),
      ]),
    );
  } finally {
    await fixture.close();
  }
});

it('uses node-ID lookups in an unanalysed projection with repeated build-local IDs, issue783', async () => {
  const nativeText = 'Rollback only if owner approval is recorded.';
  const fixture = await createProjectedWorkerRuntimeFixture({ nativeText });
  try {
    const capture = vi.spyOn(fixture.projection.raw, 'prepare');
    const catalog = new D1CatalogStore({
      db: fixture.projection,
      namespace: { projectId: PROJECT, buildId: ACTIVE_BUILD },
    });
    const result = await catalog.search('rollback', { limit: 10, nativeUnits: true });
    const sql = capture.mock.calls.find(([query]) => query.includes('AS unitText'))?.[0];
    capture.mockRestore();
    if (sql === undefined) throw new Error('Native-unit SQL was not executed.');
    expect(result[0]?.nativeUnit?.text).toBe(nativeText);
    const plan = fixture.projection.raw
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(
        PROJECT,
        ACTIVE_BUILD,
        PROJECT,
        ACTIVE_BUILD,
        PROJECT,
        ACTIVE_BUILD,
        escapeFtsQuery('rollback'),
        10,
      );
    const lookups = plan
      .map((row) => String(row.detail))
      .filter((detail) => detail.includes('unit_node'));
    expect(lookups.length).toBeGreaterThan(0);
    expect(
      lookups.every((detail) => /SEARCH unit_node.*\bid=\?/.test(detail)),
      lookups.join('\n'),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});
