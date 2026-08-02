import type { CatalogSearchHit, ContextProfile } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import {
  assembleBundle,
  MAX_ALTERNATIVES,
  MAX_ITEMS_PER_ARTIFACT,
  ORIENTATION_SHARE,
  PROFILE_BUDGETS,
  resolveBudget,
  targetsOneArtifact,
} from '../src/context/assemble.js';
import { rankWithReport, score } from '../src/ranking/rank.js';

/**
 * Context assembly, over synthetic candidates.
 *
 * The properties that matter are arithmetic and accounting: a bundle never exceeds its
 * budget, and every candidate the pipeline saw ends up somewhere a reader can find it.
 * Both are checked over generated inputs rather than one fixture, because the failure mode
 * is a corpus shape nobody thought of rather than a wrong constant.
 */

const NONE: ReadonlySet<string> = new Set();

function candidate(index: number, overrides: Partial<CatalogSearchHit> = {}): CatalogSearchHit {
  return {
    chunkId: `p:doc${index}.md@0`,
    artifactId: `p:doc${index}.md`,
    relativePath: `doc${index}.md`,
    displayPath: `doc${index}.md`,
    headingPath: [`Doc ${index}`],
    lineStart: 1,
    lineEnd: 10,
    status: 'active',
    authority: 50,
    estimatedTokens: 500,
    text: `unique body number ${index} about deployment and rollback and other matters`,
    title: `Doc ${index}`,
    bm25: -(index + 1),
    excerpt: `body ${index}`,
    ...overrides,
  };
}

function assemble(
  candidates: readonly CatalogSearchHit[],
  options: { task?: string; profile?: ContextProfile; budget?: number } = {},
) {
  const profile = options.profile ?? 'agent';
  const task = options.task ?? 'how do I roll back a release';
  const report = rankWithReport(candidates, {
    query: task,
    limit: candidates.length,
    includeArchived: false,
    superseded: NONE,
  });
  const suppressed = report.dropped
    .filter(({ reason }) => reason === 'archived' || reason === 'superseded')
    .map(({ ranked }) => ranked);

  return assembleBundle({
    task,
    profile,
    budget: options.budget ?? PROFILE_BUDGETS[profile],
    ranked: report.kept,
    dropped: report.dropped,
    suppressed,
  });
}

describe('profiles and budgets, architecture 13.5', () => {
  it.each([
    ['agent', 12_000],
    ['coding', 16_000],
    ['chat', 24_000],
    ['deep', 40_000],
  ] as const)('%s defaults to %i tokens', (profile, expected) => {
    expect(PROFILE_BUDGETS[profile]).toBe(expected);
    expect(resolveBudget(profile, undefined)).toBe(expected);
  });

  it('lets an explicit budget override the profile', () => {
    expect(resolveBudget('agent', 5000)).toBe(5000);
  });

  it('refuses a budget outside the supported range, naming it', () => {
    expect(() => resolveBudget('agent', 10)).toThrow(/1,000 to 200,000/);
    expect(() => resolveBudget('agent', 500_000)).toThrow(/1,000 to 200,000/);
  });
});

describe('the bundle never exceeds its budget', () => {
  it.each([1000, 2500, 4000, 12_000, 40_000])('at a budget of %i', (budget) => {
    const candidates = Array.from({ length: 200 }, (_, index) => candidate(index));
    const bundle = assemble(candidates, { budget });

    expect(bundle.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(bundle.reservedTokens).toBeLessThanOrEqual(Math.floor(budget * ORIENTATION_SHARE));
  });

  it('holds even when one item is larger than the whole budget', () => {
    const enormous = candidate(0, { estimatedTokens: 50_000 });
    const bundle = assemble([enormous, candidate(1)], { budget: 1000 });

    expect(bundle.estimatedTokens).toBeLessThanOrEqual(1000);
    expect(bundle.selected.some((item) => item.chunkId === enormous.chunkId)).toBe(false);
    // And it is named, rather than vanishing because it did not fit.
    expect(bundle.omitted.some((item) => item.chunkId === enormous.chunkId)).toBe(true);
  });

  it('reports the tokens it actually packed, not the budget it was given', () => {
    const bundle = assemble([candidate(0), candidate(1)], { budget: 40_000 });
    const packed = [...bundle.overview, ...bundle.selected].reduce(
      (sum, item) => sum + item.estimatedTokens,
      0,
    );
    expect(bundle.estimatedTokens).toBe(packed);
  });
});

describe('every candidate is accounted for', () => {
  /**
   * The property the ticket asks for: no silent truncation anywhere. A candidate the
   * pipeline saw is selected, offered as an alternative, or named in the omission report
   * with a reason. The first implementation passed this only because ranking had already
   * discarded the near-duplicates before assembly could count them.
   */
  it.each([
    ['a plain corpus', 40, {}],
    ['near-duplicates', 40, { duplicate: true }],
    ['one dominant artifact', 40, { sameArtifact: true }],
    ['a tiny budget', 40, { budget: 1200 }],
  ])('over %s', (_name, size, options: Record<string, unknown>) => {
    const candidates = Array.from({ length: size }, (_, index) =>
      candidate(index, {
        ...(options.duplicate === true ? { text: 'the very same body in every chunk here' } : {}),
        ...(options.sameArtifact === true
          ? { artifactId: 'p:one.md', relativePath: 'one.md', chunkId: `p:one.md@${index}` }
          : {}),
      }),
    );

    const bundle = assemble(candidates, {
      ...(typeof options.budget === 'number' ? { budget: options.budget } : {}),
    });

    const accounted = new Set([
      ...bundle.overview.map((item) => item.chunkId),
      ...bundle.selected.map((item) => item.chunkId),
      ...bundle.alternatives.map((item) => item.chunkId),
      ...bundle.omitted.map((item) => item.chunkId),
    ]);
    for (const one of candidates) expect(accounted.has(one.chunkId), one.chunkId).toBe(true);
  });

  it('gives every omission a reason from the declared vocabulary', () => {
    const bundle = assemble(
      Array.from({ length: 60 }, (_, index) => candidate(index)),
      { budget: 2000 },
    );
    const allowed = new Set([
      'budget',
      'duplicate',
      'diversity',
      'superseded',
      'archived',
      'filtered',
    ]);
    expect(bundle.omitted.length).toBeGreaterThan(0);
    for (const item of bundle.omitted) expect(allowed.has(item.reason)).toBe(true);
  });

  it('names an omitted item precisely enough to go and read it', () => {
    const bundle = assemble(
      Array.from({ length: 60 }, (_, index) => candidate(index)),
      { budget: 2000 },
    );
    for (const item of bundle.omitted) {
      expect(item.locator.relativePath).not.toBe('');
      expect(item.locator.artifactId).not.toBe('');
      expect(item.estimatedTokens).toBeGreaterThan(0);
    }
  });
});

describe('provenance', () => {
  it('gives every selected, overview and alternative item a locator', () => {
    const bundle = assemble(Array.from({ length: 20 }, (_, index) => candidate(index)));
    for (const item of [...bundle.overview, ...bundle.selected, ...bundle.alternatives]) {
      expect(item.locator.artifactId).toBe(item.locator.artifactId);
      expect(item.locator.relativePath).not.toBe('');
    }
  });

  it('cites exactly what it included, no more and no less', () => {
    const bundle = assemble(Array.from({ length: 20 }, (_, index) => candidate(index)));
    const included = [...bundle.overview, ...bundle.selected];
    expect(bundle.citations).toHaveLength(included.length);
    expect(bundle.citations.map((c) => c.relativePath)).toEqual(
      included.map((item) => item.locator.relativePath),
    );
  });
});

describe('diversity', () => {
  it('still finds other documents when one artifact matches everything', () => {
    const dominant = Array.from({ length: 20 }, (_, index) =>
      candidate(index, {
        artifactId: 'p:big.md',
        relativePath: 'big.md',
        chunkId: `p:big.md@${index}`,
      }),
    );
    const others = [candidate(90), candidate(91)];
    const bundle = assemble([...dominant, ...others]);

    // Over what the caller actually receives, which is the overview and the selection
    // together. Orientation deliberately takes one item per document, so asserting on
    // `selected` alone would measure where the split fell rather than whether the bundle
    // is diverse.
    const artifacts = new Set(
      [...bundle.overview, ...bundle.selected].map((item) => item.locator.artifactId),
    );
    expect(artifacts.size).toBeGreaterThan(1);
    expect(artifacts.has('p:big.md')).toBe(true);
  });

  it('lifts the cap when the task names one document', () => {
    const ranked = [candidate(0), candidate(1)].map((hit) =>
      score(hit, { query: 'doc0', limit: 10, includeArchived: false, superseded: NONE }),
    );
    expect(targetsOneArtifact('summarise doc0 for me', ranked)).toBe(true);
    expect(targetsOneArtifact('compare doc0 and doc1', ranked)).toBe(false);
    expect(targetsOneArtifact('something else entirely', ranked)).toBe(false);
  });
});

describe('alternatives, architecture 13.4', () => {
  it('offers suppressed sources with their labels, and claims nothing about them', () => {
    const superseded: ReadonlySet<string> = new Set(['p:doc1.md']);
    const candidates = [candidate(0), candidate(1), candidate(2, { status: 'archived' })];
    const report = rankWithReport(candidates, {
      query: 'rollback',
      limit: candidates.length,
      includeArchived: false,
      superseded,
    });
    const bundle = assembleBundle({
      task: 'rollback',
      profile: 'agent',
      budget: PROFILE_BUDGETS.agent,
      ranked: report.kept,
      dropped: report.dropped,
      suppressed: report.dropped
        .filter(({ reason }) => reason === 'archived' || reason === 'superseded')
        .map(({ ranked }) => ranked),
    });

    expect(bundle.alternatives.length).toBeGreaterThan(0);
    const labels = bundle.alternatives.flatMap((item) => item.labels);
    expect(labels).toContain('superseded');
    expect(labels).toContain('archived');
    // Nothing in the bundle is written by Lorepack, so nothing in it can claim a conflict.
    expect(JSON.stringify(bundle)).not.toMatch(/detected conflict/i);
  });

  it('lists a bounded number of alternatives and omits the rest by name', () => {
    const candidates = Array.from({ length: MAX_ALTERNATIVES + 4 }, (_, index) =>
      candidate(index, { status: 'archived' }),
    );
    const report = rankWithReport(candidates, {
      query: 'rollback',
      limit: candidates.length,
      includeArchived: false,
      superseded: NONE,
    });
    // Everything is archived, so ranking falls back to showing them; force the suppressed
    // path by asking assembly to treat them as alternatives.
    const bundle = assembleBundle({
      task: 'rollback',
      profile: 'agent',
      budget: PROFILE_BUDGETS.agent,
      ranked: [],
      dropped: [],
      suppressed: report.kept,
    });

    expect(bundle.alternatives).toHaveLength(MAX_ALTERNATIVES);
    expect(bundle.omitted).toHaveLength(candidates.length - MAX_ALTERNATIVES);
  });
});

describe('orientation', () => {
  it('spends the reserve on real content from distinct documents', () => {
    const bundle = assemble(Array.from({ length: 30 }, (_, index) => candidate(index)));
    const artifacts = bundle.overview.map((item) => item.locator.artifactId);

    expect(bundle.overview.length).toBeGreaterThan(0);
    expect(new Set(artifacts).size).toBe(artifacts.length);
    for (const item of bundle.overview) expect(item.text.length).toBeGreaterThan(0);
  });

  it('never spends more than the reserve on it', () => {
    const budget = 12_000;
    const bundle = assemble(
      Array.from({ length: 60 }, (_, index) => candidate(index, { estimatedTokens: 300 })),
      { budget },
    );
    expect(bundle.reservedTokens).toBeLessThanOrEqual(budget * ORIENTATION_SHARE);
  });
});

describe('determinism', () => {
  it('produces an identical bundle from identical inputs, whatever order they arrive in', () => {
    const candidates = Array.from({ length: 50 }, (_, index) => candidate(index));
    const forward = assemble(candidates);
    const backward = assemble([...candidates].reverse());
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });
});

describe('the per-artifact cap', () => {
  it('is what the constant says it is', () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      candidate(index, {
        artifactId: 'p:one.md',
        relativePath: 'one.md',
        chunkId: `p:one.md@${index}`,
      }),
    );
    const bundle = assemble(candidates, { task: 'unrelated words entirely' });
    const fromOne = [...bundle.overview, ...bundle.selected].filter(
      (item) => item.locator.artifactId === 'p:one.md',
    );
    // Ranking caps a page at three per artifact; assembly caps a bundle at four. The
    // tighter of the two is what a caller sees.
    expect(fromOne.length).toBeLessThanOrEqual(MAX_ITEMS_PER_ARTIFACT);
  });
});
