import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { loadConfig, ProgressBus, type SearchResult } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';

/**
 * Retrieval fixtures, architecture 20.7: a query, the sources that must come back, the
 * sources that must not, and the provenance every result carries.
 *
 * These run against a real build and a real index, which is what makes them regression
 * tests rather than restatements of the ranking code. The per-step unit tests in
 * `packages/runtime/test/ranking.test.ts` use synthetic scores; this file asks whether the
 * whole path, tokenizer included, answers the question a person actually typed.
 */

const CONFIG = 'version: 1\nname: fixtures\nsources:\n  - .\n';

/**
 * A corpus with the ambiguity that makes ranking worth having: three documents mention
 * rollback, one is named for it, one is about something else entirely, and one repeats a
 * neighbour almost word for word.
 */
const CORPUS = {
  'lore.yaml': CONFIG,
  'guides/rollback.md':
    '# Rollback\n\n## Procedure\n\nActivate the previous build. Rollback is a pointer change and never recompiles.\n',
  'guides/deployment.md':
    '# Deployment\n\n## Rollback\n\nWhen a release misbehaves, roll back to the previous build.\n\n## Scheduling\n\nDeployments happen on Tuesdays unless a freeze is in effect.\n',
  'guides/onboarding.md':
    '# Onboarding\n\n## Laptop\n\nCollect your laptop from IT and request VPN access on day one.\n',
  'notes/standup-monday.txt':
    'Standup: we discussed the rollback procedure and agreed to document it properly.\n',
  // Near-identical to the Monday note, which is what near-duplicate removal is for.
  'notes/standup-tuesday.txt':
    'Standup: we discussed the rollback procedure and agreed to document it properly.\n',
};

async function search(
  query: string,
  overrides: Partial<Parameters<ReturnType<typeof createRuntime>['search']>[0]> = {},
): Promise<SearchResult> {
  return withTempProject({ files: CORPUS }, async (project) => {
    await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
    const backend = createLocalRuntimeBackend({ projectRoot: project.root });
    try {
      return await createRuntime(backend).search({
        query,
        limit: 10,
        includeArchived: false,
        debug: false,
        ...overrides,
      });
    } finally {
      backend.close();
    }
  });
}

const paths = (result: SearchResult): string[] =>
  result.hits.map((hit) => hit.locator.relativePath);

describe('fixture: "rollback"', () => {
  it('puts the document named for the query first', async () => {
    const result = await search('rollback');
    expect(paths(result)[0]).toBe('guides/rollback.md');
  });

  it('returns every source that discusses it, and nothing that does not', async () => {
    const result = await search('rollback');
    const found = new Set(paths(result));

    expect(found).toContain('guides/rollback.md');
    expect(found).toContain('guides/deployment.md');
    expect(found).not.toContain('guides/onboarding.md');
  });

  it('collapses the two standup notes that say the same thing', async () => {
    const result = await search('rollback');
    const standups = paths(result).filter((path) => path.startsWith('notes/standup'));
    expect(standups).toHaveLength(1);
  });

  it('carries complete provenance on every hit', async () => {
    const result = await search('rollback');
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(hit.locator.relativePath).not.toBe('');
      expect(hit.locator.artifactId).toBe(hit.artifactId);
      expect(hit.locator.lineStart ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('fixture: "vpn access"', () => {
  it('finds the onboarding guide and not the deployment one', async () => {
    const result = await search('vpn access');
    expect(paths(result)[0]).toBe('guides/onboarding.md');
    expect(paths(result)).not.toContain('guides/rollback.md');
  });
});

describe('fixture: a heading that is not a filename', () => {
  it('ranks the section headed for the query above the rest of its own document', async () => {
    const result = await search('scheduling');
    const [first] = result.hits;
    expect(first?.locator.relativePath).toBe('guides/deployment.md');
    expect(first?.locator.headingPath).toContain('Scheduling');
  });
});

describe('the page is explainable and reproducible', () => {
  it('returns score components only when asked, and names them', async () => {
    const plain = await search('rollback');
    const debug = await search('rollback', { debug: true });

    expect(plain.hits.every((hit) => hit.scoreComponents === undefined)).toBe(true);
    const components = debug.hits[0]?.scoreComponents ?? {};
    expect(components).toHaveProperty('lexical');
    expect(components).toHaveProperty('lexicalRaw');
    expect(components).toHaveProperty('total');
    expect(components.total).toBeCloseTo(debug.hits[0]?.score ?? -1, 6);
  });

  it('answers an identical query on an identical build identically', async () => {
    // Two separate builds of the same sources, in two temp directories: identical ordering
    // and identical scores, or a caller can cache nothing (invariant 3).
    const [first, second] = await Promise.all([search('rollback'), search('rollback')]);

    expect(first.buildId).toBe(second.buildId);
    expect(JSON.stringify(second.hits)).toBe(JSON.stringify(first.hits));
  });

  it('never lets one document fill the page', async () => {
    const result = await search('the');
    const perArtifact = new Map<string, number>();
    for (const hit of result.hits) {
      perArtifact.set(hit.artifactId, (perArtifact.get(hit.artifactId) ?? 0) + 1);
    }
    for (const [, used] of perArtifact) expect(used).toBeLessThanOrEqual(3);
  });
});

describe('filters', () => {
  it('narrows by path glob, by extension, and returns nothing rather than guessing', async () => {
    expect(
      paths(await search('rollback', { pathGlob: 'notes/*' })).every((p) => p.startsWith('notes/')),
    ).toBe(true);
    expect(
      paths(await search('rollback', { fileType: 'txt' })).every((p) => p.endsWith('.txt')),
    ).toBe(true);
    expect((await search('rollback', { pathGlob: 'nothing/*' })).hits).toEqual([]);
  });

  it('narrows to one document, which is how a follow-up question stays on topic', async () => {
    // Addressed by path, as the locator on the previous answer gave it.
    const byPath = await search('rollback', { artifactId: 'guides/deployment.md' });
    expect(byPath.hits.length).toBeGreaterThan(0);
    expect(paths(byPath).every((path) => path === 'guides/deployment.md')).toBe(true);

    // And by artifact id, as the structured result gave it. Both work, because a caller
    // holds whichever the last answer handed it.
    const id = byPath.hits[0]?.locator.artifactId as string;
    const byId = await search('rollback', { artifactId: id });
    expect(byId.hits.map((hit) => hit.locator.artifactId).every((each) => each === id)).toBe(true);
    expect(paths(byId)).toEqual(paths(byPath));
  });

  it('excludes near matches rather than widening to them', async () => {
    // `guides/rollback.md` exists and outranks everything for this query. Asking for a
    // prefix of a real id must return nothing, not the document it nearly names.
    expect((await search('rollback', { artifactId: 'guides/' })).hits).toEqual([]);
    expect((await search('rollback', { artifactId: 'guides/rollbac' })).hits).toEqual([]);
  });

  it('combines with the other filters instead of replacing them', async () => {
    const contradictory = await search('rollback', {
      artifactId: 'guides/rollback.md',
      pathGlob: 'notes/*',
    });
    expect(contradictory.hits).toEqual([]);
  });
});
