import { describe, expect, it } from 'vitest';
import { exhaustiveTopK, safePrunedTopK } from '../../../scripts/research-safe-pruning.mjs';

describe('safe retrieval pruning prototype', () => {
  it('returns the exhaustive top-k result while skipping bounded postings', () => {
    const postings = new Map([
      [
        'alpha',
        [
          { docId: 'a', contribution: 10 },
          { docId: 'b', contribution: 1 },
          { docId: 'c', contribution: 0.5 },
        ],
      ],
      [
        'beta',
        [
          { docId: 'a', contribution: 9 },
          { docId: 'b', contribution: 1 },
          { docId: 'c', contribution: 0.5 },
        ],
      ],
    ]);

    const exhaustive = exhaustiveTopK(postings, 'alpha beta', 1);
    const pruned = safePrunedTopK(postings, 'alpha beta', 1);

    expect(pruned.results).toEqual(exhaustive);
    expect(pruned.evaluatedPostings).toBeLessThan(pruned.totalPostings);
  });

  it('keeps deterministic tie ordering', () => {
    const postings = new Map([
      [
        'same',
        [
          { docId: 'b', contribution: 1 },
          { docId: 'a', contribution: 1 },
        ],
      ],
    ]);

    expect(exhaustiveTopK(postings, 'same', 2)).toEqual([
      { docId: 'a', score: 1 },
      { docId: 'b', score: 1 },
    ]);
    expect(safePrunedTopK(postings, 'same', 2).results).toEqual([
      { docId: 'a', score: 1 },
      { docId: 'b', score: 1 },
    ]);
  });
});
