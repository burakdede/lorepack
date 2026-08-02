import { type CatalogSearchHit, candidateCount, RANKING_WEIGHTS } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import {
  applyVisibility,
  authorityMultiplier,
  exactMatchBoost,
  limitPerArtifact,
  rankCandidates,
  removeNearDuplicates,
  saturate,
  score,
  sortDeterministically,
} from '../src/ranking/rank.js';

/**
 * Each step of architecture 13.2 on its own, with synthetic scores.
 *
 * Synthetic on purpose: a ranking test driven by a real index measures the index and the
 * tokenizer as much as the ranking, and moves whenever either does. What has to hold is
 * that a named boost lifts what it claims to lift, by the amount the weights table says.
 */

function candidate(overrides: Partial<CatalogSearchHit> = {}): CatalogSearchHit {
  return {
    chunkId: 'p:guides/a.md@0',
    artifactId: 'p:guides/a.md',
    relativePath: 'guides/a.md',
    displayPath: 'guides/a.md',
    headingPath: ['Deployment'],
    lineStart: 1,
    lineEnd: 4,
    status: 'active',
    authority: 50,
    estimatedTokens: 20,
    text: 'rollback restores the previous release without recompiling anything at all',
    title: 'Deployment guide',
    bm25: -1,
    excerpt: 'rollback [restores]',
    ...overrides,
  };
}

const NONE: ReadonlySet<string> = new Set();

function input(overrides: Partial<Parameters<typeof rankCandidates>[1]> = {}) {
  return { query: 'rollback', limit: 10, includeArchived: false, superseded: NONE, ...overrides };
}

describe('step 2: exact match boosts', () => {
  it('lifts a chunk whose file is named for the query', () => {
    const boosts = exactMatchBoost(candidate({ relativePath: 'guides/rollback.md' }), 'rollback');
    expect(boosts.pathExact).toBe(RANKING_WEIGHTS.exactMatch.path);
  });

  it('lifts a chunk whose artifact is titled for the query, more than the path does', () => {
    const boosts = exactMatchBoost(candidate({ title: 'Rollback' }), 'rollback');
    expect(boosts.titleExact).toBe(RANKING_WEIGHTS.exactMatch.title);
    expect(RANKING_WEIGHTS.exactMatch.title).toBeGreaterThan(RANKING_WEIGHTS.exactMatch.path);
  });

  it('lifts a chunk sitting under a heading with that name', () => {
    const boosts = exactMatchBoost(
      candidate({ headingPath: ['Deployment', 'Rollback'] }),
      'rollback',
    );
    expect(boosts.headingExact).toBe(RANKING_WEIGHTS.exactMatch.heading);
  });

  it('rewards covering every term of a multi-word query, in any order', () => {
    const hit = candidate({ text: 'the release rollback procedure' });
    expect(exactMatchBoost(hit, 'rollback release').allTerms).toBe(
      RANKING_WEIGHTS.exactMatch.allTerms,
    );
    expect(exactMatchBoost(hit, 'rollback bicycle').allTerms).toBe(0);
  });

  it('never boosts on the empty query', () => {
    const boosts = exactMatchBoost(candidate({ relativePath: 'a.md', title: null }), '');
    expect(Object.values(boosts).every((value) => value === 0)).toBe(true);
  });

  it('measurably reorders: the named file wins over a stronger lexical match', () => {
    const named = candidate({
      chunkId: 'p:guides/rollback.md@0',
      artifactId: 'p:guides/rollback.md',
      relativePath: 'guides/rollback.md',
      bm25: -1,
    });
    const wordy = candidate({
      chunkId: 'p:guides/other.md@0',
      artifactId: 'p:guides/other.md',
      relativePath: 'guides/other.md',
      title: null,
      bm25: -3,
    });

    const ranked = rankCandidates([wordy, named], input());
    expect(ranked[0]?.hit.relativePath).toBe('guides/rollback.md');
  });
});

describe('step 3 and 5: status and supersession', () => {
  it('penalises a draft and labels it', () => {
    const ranked = score(candidate({ status: 'draft' }), input());
    expect(ranked.components.statusFactor).toBe(RANKING_WEIGHTS.status.draft);
    expect(ranked.labels).toContain('draft');
    expect(ranked.score).toBeLessThan(score(candidate(), input()).score);
  });

  it('excludes archived sources by default', () => {
    const archived = score(candidate({ status: 'archived' }), input());
    const active = score(candidate({ chunkId: 'b', artifactId: 'b' }), input());
    expect(applyVisibility([archived, active], input())).toEqual([active]);
  });

  it('includes archived sources when asked, with a label', () => {
    const archived = score(candidate({ status: 'archived' }), input({ includeArchived: true }));
    const visible = applyVisibility([archived], input({ includeArchived: true }));
    expect(visible).toHaveLength(1);
    expect(visible[0]?.labels).toContain('archived');
  });

  it('falls back to archived sources when nothing active matched at all', () => {
    // Architecture 12.7: searchable when requested, or when no active source satisfies it.
    const archived = score(candidate({ status: 'archived' }), input());
    expect(applyVisibility([archived], input())).toHaveLength(1);
  });

  it('suppresses a superseded source from default results and keeps it labelled', () => {
    const superseded: ReadonlySet<string> = new Set(['p:guides/a.md']);
    const options = input({ superseded });
    const hit = score(candidate(), options);
    const other = score(candidate({ chunkId: 'b', artifactId: 'b' }), options);

    expect(hit.labels).toContain('superseded');
    expect(applyVisibility([hit, other], options)).toEqual([other]);
    // Still reachable on request, which is what "remains readable" means for search.
    expect(applyVisibility([hit], { ...options, includeArchived: true })).toHaveLength(1);
  });
});

describe('step 4: declared authority', () => {
  it('is exactly neutral at the default, so a default declares nothing', () => {
    expect(authorityMultiplier(RANKING_WEIGHTS.authority.neutral)).toBe(1);
  });

  it('spans a deliberately narrow range, so a hint cannot become a truth claim', () => {
    expect(authorityMultiplier(0)).toBe(RANKING_WEIGHTS.authority.minimum);
    expect(authorityMultiplier(100)).toBe(RANKING_WEIGHTS.authority.maximum);
    expect(authorityMultiplier(100)).toBeLessThan(2);
  });

  it('rises monotonically', () => {
    const values = [0, 10, 25, 50, 75, 90, 100].map(authorityMultiplier);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it('breaks a tie without overturning a much better match', () => {
    const authoritative = candidate({ chunkId: 'a', artifactId: 'a', authority: 100, bm25: -1 });
    const better = candidate({
      chunkId: 'b',
      artifactId: 'b',
      authority: 0,
      bm25: -4,
      title: null,
    });

    expect(rankCandidates([authoritative, better], input())[0]?.hit.chunkId).toBe('b');

    const tied = candidate({ chunkId: 'c', artifactId: 'c', authority: 0, bm25: -1, title: null });
    expect(rankCandidates([tied, authoritative], input())[0]?.hit.chunkId).toBe('a');
  });
});

describe('step 8: near-duplicate removal', () => {
  it('keeps the better-scoring copy of two near-identical chunks', () => {
    const body = 'rollback restores the previous release without recompiling anything at all';
    const strong = score(
      candidate({ chunkId: 'a', artifactId: 'a', text: body, bm25: -5 }),
      input(),
    );
    const weak = score(
      candidate({ chunkId: 'b', artifactId: 'b', text: `${body} .`, bm25: -1 }),
      input(),
    );

    const kept = removeNearDuplicates([weak, strong]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.hit.chunkId).toBe('a');
  });

  it('keeps two chunks that merely share a topic', () => {
    const one = score(
      candidate({
        chunkId: 'a',
        artifactId: 'a',
        text: 'rollback restores the previous release safely',
      }),
      input(),
    );
    const two = score(
      candidate({
        chunkId: 'b',
        artifactId: 'b',
        text: 'the deployment schedule is agreed at standup every morning',
      }),
      input(),
    );
    expect(removeNearDuplicates([one, two])).toHaveLength(2);
  });
});

describe('step 9: artifact diversity', () => {
  it('stops one document from being the whole page', () => {
    const many = Array.from({ length: 6 }, (_, index) =>
      score(
        candidate({
          chunkId: `p:guides/a.md@${index}`,
          text: `section ${index} unique words here`,
        }),
        input(),
      ),
    );
    expect(limitPerArtifact(many)).toHaveLength(RANKING_WEIGHTS.diversity.maxChunksPerArtifact);
  });
});

describe('determinism', () => {
  it('breaks ties by canonical path and then chunk id', () => {
    const later = score(
      candidate({ chunkId: 'p:z.md@0', artifactId: 'z', relativePath: 'z.md' }),
      input(),
    );
    const earlier = score(
      candidate({ chunkId: 'p:a.md@0', artifactId: 'a', relativePath: 'a.md' }),
      input(),
    );

    expect(sortDeterministically([later, earlier]).map((r) => r.hit.relativePath)).toEqual([
      'a.md',
      'z.md',
    ]);
  });

  it('produces the same page from the same candidates, whatever order they arrive in', () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      candidate({
        chunkId: `p:doc${index}.md@0`,
        artifactId: `p:doc${index}.md`,
        relativePath: `doc${index}.md`,
        text: `rollback discussion number ${index} with distinct wording ${'x'.repeat(index)}`,
        // Deliberately tied scores, which is when ordering is decided by the tie-break.
        bm25: index % 2 === 0 ? -2 : -1,
        title: null,
      }),
    );

    const forward = rankCandidates(candidates, input());
    const backward = rankCandidates([...candidates].reverse(), input());

    expect(backward.map((r) => r.hit.chunkId)).toEqual(forward.map((r) => r.hit.chunkId));
    expect(backward.map((r) => r.score)).toEqual(forward.map((r) => r.score));
  });
});

describe('score components', () => {
  it('names every contribution, so a page can be explained', () => {
    const ranked = score(
      candidate({ relativePath: 'guides/rollback.md', status: 'draft', authority: 90 }),
      input(),
    );

    // Bounded, not raw: `lexicalRaw` is the BM25 the index reported.
    expect(ranked.components.lexicalRaw).toBe(1);
    expect(ranked.components.lexical).toBeCloseTo(1 / (1 + RANKING_WEIGHTS.lexical.saturation), 6);
    expect(ranked.components.pathExact).toBe(RANKING_WEIGHTS.exactMatch.path);
    expect(ranked.components.statusFactor).toBe(RANKING_WEIGHTS.status.draft);
    expect(ranked.components.authorityFactor).toBeGreaterThan(1);
    expect(ranked.components.total).toBe(ranked.score);
  });

  it('omits a component that contributed nothing, rather than reporting a zero', () => {
    const ranked = score(candidate({ title: null, headingPath: [] }), input());
    expect(ranked.components).not.toHaveProperty('titleExact');
    expect(ranked.components).not.toHaveProperty('statusFactor');
  });
});

describe('candidate depth', () => {
  it('asks the index for more than the page, or every boost would be decorative', () => {
    expect(candidateCount(10)).toBeGreaterThan(10);
    expect(candidateCount(1)).toBe(RANKING_WEIGHTS.candidates.minimum);
    expect(candidateCount(100)).toBeLessThanOrEqual(RANKING_WEIGHTS.candidates.maximum);
  });
});

describe('the lexical component is bounded', () => {
  /**
   * Measured, not assumed: on this project a query for a term present in every document
   * scores about 0.000002, and the same query shape over varied prose scores about 5.4.
   * A fixed additive boost has to mean the same thing in both, or the weights cannot be
   * tuned and the debug output cannot be read.
   */
  it('maps any BM25 onto [0, 1)', () => {
    for (const raw of [0, 0.000002, 1, 5.43, 12, 100, 10_000]) {
      const value = saturate(raw);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is monotone, so a better match never ranks lower for being scaled', () => {
    const values = [0, 0.5, 1, 2, 6, 20, 500].map(saturate);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it('is exactly half at the saturation point, which is what makes the constant readable', () => {
    expect(saturate(RANKING_WEIGHTS.lexical.saturation)).toBe(0.5);
  });

  it('lets a boost decide between comparable matches, and not override a much better one', () => {
    // The intent, stated as the two cases that matter. A document titled for the query
    // wins a close contest, because that is what a person means by typing a name. It does
    // not beat a section that genuinely covers the subject in depth, because a title is a
    // label and the deeper match is more likely to be the answer.
    const comparable = saturate(2);
    const titled = saturate(2) + RANKING_WEIGHTS.exactMatch.title;
    expect(titled).toBeGreaterThan(comparable);

    const muchBetter = saturate(12);
    const titledButThin = saturate(0.5) + RANKING_WEIGHTS.exactMatch.title;
    expect(titledButThin).toBeLessThan(muchBetter);
  });
});
