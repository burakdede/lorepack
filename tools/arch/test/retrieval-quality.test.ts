import { describe, expect, it } from 'vitest';
import {
  compareBaseline,
  evaluateQuality,
  matchesLocation,
} from '../../../scripts/bench-quality.mjs';

const location = {
  relativePath: 'pack-000/000-product-strategy.md',
  lineStart: 9,
  lineEnd: 9,
  headingPath: ['Product Strategy'],
};

describe('retrieval quality evaluator', () => {
  it('matches the labelled source coordinate, not just the filename', () => {
    expect(
      matchesLocation(location, {
        artifact: 'fixtures/documents/markdown/product-strategy.md',
        lineStart: 9,
        lineEnd: 9,
        headingPath: ['Product Strategy'],
      }),
    ).toBe(true);
    expect(
      matchesLocation(location, {
        artifact: 'fixtures/documents/markdown/product-strategy.md',
        lineStart: 21,
        lineEnd: 21,
      }),
    ).toBe(false);
  });

  it('reports hit@1, hit@5 and complete context citation coverage', () => {
    const quality = evaluateQuality([
      {
        kind: 'search',
        expected: [
          { artifact: 'fixtures/documents/markdown/product-strategy.md', lineStart: 9, lineEnd: 9 },
        ],
        hits: [{ locator: location }],
      },
      {
        kind: 'context',
        expected: [
          { artifact: 'fixtures/documents/markdown/product-strategy.md', lineStart: 9, lineEnd: 9 },
        ],
        citations: [location],
      },
    ]);
    expect(quality.search).toEqual({ cases: 1, hitAt1: 1, hitAt5: 1 });
    expect(quality.contextForTask).toEqual({ cases: 1, allExpectedCited: 1 });
  });

  it('fails the baseline when a ranking change drops a labelled hit', () => {
    const failures = compareBaseline(
      { search: { hitAt1: 0, hitAt5: 0.5 }, contextForTask: { allExpectedCited: 1 } },
      { search: { hitAt1: 1, hitAt5: 1 }, contextForTask: { allExpectedCited: 1 } },
    );
    expect(failures).toEqual([
      'search.hitAt1 dropped from 1 to 0',
      'search.hitAt5 dropped from 1 to 0.5',
    ]);
  });
});
