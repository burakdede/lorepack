import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { type ContextBundle, contextBundleSchema, loadConfig, ProgressBus } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';

/**
 * Bundle fixtures against a real build, architecture 20.7.
 *
 * The unit tests in `packages/runtime/test/context.test.ts` prove the arithmetic over
 * synthetic candidates. This file asks the question those cannot: does a task phrased the
 * way a person phrases one actually come back with the right documents? The first
 * implementation returned an empty bundle for every task, because the index was asked for
 * chunks containing every word of "how do I roll back a release" and no chunk contains all
 * of those.
 */

const CONFIG = 'version: 1\nname: bundles\nsources:\n  - .\n';

const CORPUS = {
  'lore.yaml': CONFIG,
  'guides/rollback.md':
    '# Rollback\n\n## Procedure\n\nActivate the previous build. Rollback is a pointer change and never recompiles the index.\n\n## After a rollback\n\nTell the team, and open an incident note if customers noticed.\n',
  'guides/deployment.md':
    '# Deployment\n\n## Release\n\nDeployments happen on Tuesdays unless a change freeze is in effect.\n\n## Rollback\n\nWhen a release misbehaves, roll back to the previous build before investigating.\n',
  'guides/onboarding.md':
    '# Onboarding\n\n## Laptop\n\nCollect your laptop from IT and request VPN access on day one.\n\n## Buddy\n\nEveryone is assigned a buddy for their first week.\n',
  'notes/incident-2026-01.md':
    '# Incident, January\n\nThe release was rolled back after the payment queue backed up.\n',
};

async function bundleFor(
  task: string,
  overrides: Partial<Parameters<ReturnType<typeof createRuntime>['contextForTask']>[0]> = {},
): Promise<ContextBundle> {
  return withTempProject({ files: CORPUS }, async (project) => {
    await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
    const backend = createLocalRuntimeBackend({ projectRoot: project.root });
    try {
      return await createRuntime(backend).contextForTask({
        task,
        includeArchived: false,
        ...overrides,
      });
    } finally {
      backend.close();
    }
  });
}

const included = (bundle: ContextBundle): string[] =>
  [...bundle.overview, ...bundle.selected].map((item) => item.locator.relativePath);

describe('a task phrased as a sentence', () => {
  it('returns the documents that answer it', async () => {
    const bundle = await bundleFor('how do I roll back a release that went wrong');

    expect(bundle.selected.length + bundle.overview.length).toBeGreaterThan(0);
    expect(included(bundle)).toContain('guides/rollback.md');
    expect(included(bundle)).toContain('guides/deployment.md');
  });

  it('is not defeated by its own filler words', async () => {
    // Every one of these contains words no chunk has, which is what broke the first
    // implementation: an all-terms index query matched nothing at all.
    for (const task of [
      'what should I do when a deployment goes badly',
      'please explain the rollback procedure to me',
      'I need to understand how onboarding works here',
    ]) {
      const bundle = await bundleFor(task);
      expect(bundle.citations.length, task).toBeGreaterThan(0);
    }
  });

  it('answers a single keyword too, precisely', async () => {
    const bundle = await bundleFor('onboarding');
    expect(included(bundle)).toContain('guides/onboarding.md');
  });
});

describe('the bundle satisfies its published contract', () => {
  it('parses against the committed schema, including the budget refinement', async () => {
    const bundle = await bundleFor('how do I roll back a release');
    expect(() => contextBundleSchema.parse(bundle)).not.toThrow();
  });

  it('carries the build it read and the freshness it observed', async () => {
    const bundle = await bundleFor('rollback');
    expect(bundle.buildId).toMatch(/^lore_[0-9a-f]{64}$/);
    expect(['clean', 'dirty', 'unknown']).toContain(bundle.sourceState);
  });

  it('defaults to the agent profile and its budget', async () => {
    const bundle = await bundleFor('rollback');
    expect(bundle.profile).toBe('agent');
    expect(bundle.budget).toBe(12_000);
  });

  it('honours an explicit profile and an explicit budget', async () => {
    expect((await bundleFor('rollback', { profile: 'deep' })).budget).toBe(40_000);
    expect((await bundleFor('rollback', { budget: 3000 })).budget).toBe(3000);
  });
});

describe('nothing is invented and nothing is hidden', () => {
  it('contains only text that exists in the corpus', async () => {
    const bundle = await bundleFor('how do I roll back a release');
    const corpus = Object.values(CORPUS).join('\n');

    for (const item of [...bundle.overview, ...bundle.selected]) {
      // Every sentence in the bundle came out of a file. Normalization may reflow
      // whitespace, so the comparison is on words rather than on bytes.
      const words = item.text.split(/\s+/).filter((word) => word.length > 6);
      for (const word of words.slice(0, 5)) expect(corpus).toContain(word);
    }
  });

  it('never claims a conflict, whatever the corpus looks like', async () => {
    const bundle = await bundleFor('rollback');
    expect(JSON.stringify(bundle)).not.toMatch(/detected conflict|contradicts/i);
  });

  it('lists each chunk in exactly one place', async () => {
    const bundle = await bundleFor('rollback', { budget: 1200 });
    const everywhere = [
      ...bundle.overview.map((item) => item.chunkId),
      ...bundle.selected.map((item) => item.chunkId),
      ...bundle.alternatives.map((item) => item.chunkId),
      ...bundle.omitted.map((item) => item.chunkId),
    ];
    expect(new Set(everywhere).size).toBe(everywhere.length);
  });

  it('reports omissions once the budget actually binds', async () => {
    // This corpus fits in any legal budget, so it can prove the report is complete but not
    // that it is non-empty. A corpus that cannot fit is what makes the omission report do
    // any work at all.
    const many: Record<string, string> = { 'lore.yaml': CONFIG };
    for (let index = 0; index < 60; index += 1) {
      many[`docs/note-${index}.md`] =
        `# Note ${index}\n\nRollback guidance number ${index}. ${'detail '.repeat(120)}\n`;
    }

    const bundle = await withTempProject({ files: many }, async (project) => {
      await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      try {
        return await createRuntime(backend).contextForTask({
          task: 'rollback guidance',
          includeArchived: false,
          budget: 2000,
        });
      } finally {
        backend.close();
      }
    });

    expect(bundle.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(bundle.omitted.length).toBeGreaterThan(0);
    expect(bundle.omitted.some((item) => item.reason === 'budget')).toBe(true);
    for (const item of bundle.omitted) expect(item.locator.relativePath).not.toBe('');
  });

  it('stays inside a small budget and says what it dropped', async () => {
    const bundle = await bundleFor('rollback deployment onboarding incident', { budget: 1000 });
    expect(bundle.estimatedTokens).toBeLessThanOrEqual(1000);
    expect(bundle.omitted.every((item) => item.locator.relativePath !== '')).toBe(true);
  });
});

describe('determinism', () => {
  it('assembles an identical bundle for an identical task on an identical build', async () => {
    const task = 'how do I roll back a release';
    const [first, second] = await Promise.all([bundleFor(task), bundleFor(task)]);
    expect(first.buildId).toBe(second.buildId);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
