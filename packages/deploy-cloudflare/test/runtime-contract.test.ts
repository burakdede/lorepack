import { NATIVE_UNIT_LIMITS } from '@lorepack/core';
import { expect, it } from 'vitest';
import { type ContractFixture, runRuntimeContract } from '../../../tools/test-support/src/index.ts';
import {
  activateProjectedWorkerRuntimeFixture,
  createProjectedWorkerRuntimeFixture,
} from './projected-runtime-fixture.js';

runRuntimeContract({
  sqlProfile: 'remote',
  name: 'Cloudflare projected SQLite and object ports',
  create: async (): Promise<ContractFixture> => await createProjectedWorkerRuntimeFixture(),
  activateAnother: async (): Promise<string> => await activateProjectedWorkerRuntimeFixture(),
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
