import type { ExecutionPolicy } from '@lorepack/core';
import { expect, it } from 'vitest';
import { identifyExecution, resolveExecutionPolicy } from '../src/context/execution.js';

const policy = () =>
  resolveExecutionPolicy({
    profile: 'agent',
    budget: 12_000,
    includeArchived: false,
    compilerVersion: '0.1.0',
  });
const selection = {
  corpusId: `corpus_${'c'.repeat(32)}`,
  namespaceId: `namespace_${'d'.repeat(32)}`,
  buildId: `lore_${'a'.repeat(64)}`,
  task: 'restore the checkpoint',
  filters: [],
};

it('canonicalizes resolved filter order and duplicates without using observation state', async () => {
  const path = { kind: 'path' as const, value: '*.md' };
  const status = { kind: 'status' as const, value: 'active' };
  const filters = [path, status];
  const first = await identifyExecution(policy(), { ...selection, filters });
  const reordered = await identifyExecution(policy(), {
    ...selection,
    filters: [status, path, path],
  });
  expect(reordered).toEqual(first);
});

it.each([
  ['retrieval', 'version'],
  ['retrieval', 'queryVersion'],
  ['retrieval', 'rankingVersion'],
  ['retrieval', 'weightsVersion'],
  ['packing', 'version'],
  ['estimator', 'version'],
  ['visibility', 'version'],
  ['serialization', 'version'],
] as const)('changes policy identity when %s.%s changes', async (section, field) => {
  const first = await identifyExecution(policy(), selection);
  const changed = policy();
  (changed[section] as Record<string, unknown>)[field] = 2;
  expect((await identifyExecution(changed, selection)).policyId).not.toBe(first.policyId);
});

it('changes policy identity for resolved packing constants and actual ranking weights', async () => {
  const first = await identifyExecution(policy(), selection);
  const packing = policy();
  packing.packing.orientationShare = 0.2;
  expect((await identifyExecution(packing, selection)).policyId).not.toBe(first.policyId);
  const ranking = policy();
  const weights = ranking.retrieval.weights as { lexical: { saturation: number } };
  weights.lexical.saturation += 1;
  expect((await identifyExecution(ranking, selection)).policyId).not.toBe(first.policyId);
});

it('refuses unknown descriptor fields and unsupported top-level versions', async () => {
  await expect(
    identifyExecution({ ...policy(), version: 2 } as unknown as ExecutionPolicy, selection),
  ).rejects.toThrow();
  await expect(
    identifyExecution({ ...policy(), timestamp: 'now' } as unknown as ExecutionPolicy, selection),
  ).rejects.toThrow();
});
