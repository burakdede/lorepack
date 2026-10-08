import { describe, expect, it } from 'vitest';
import {
  changeReviewWorkload,
  contextBudgetFit,
  contextPlacement,
  expectedLocationCoverage,
  provenanceCoverage,
  rollbackEvidence,
} from '../../../scripts/benchmark-metrics.mjs';

describe('usefulness metric definitions', () => {
  it('counts provenance over search, context and table output denominators', () => {
    expect(
      provenanceCoverage([
        { relativePath: 'docs/a.md', lineStart: 1, lineEnd: 2 },
        { relativePath: 'docs/b.md' },
        { relativePath: 'tables/a.csv', cellRange: 'A1:B2' },
      ]),
    ).toEqual({ numerator: 2, denominator: 3, ratio: 2 / 3, invalid: 1 });
  });

  it('keeps context budget fit and omission reasons visible', () => {
    expect(
      contextBudgetFit([
        { budget: 100, estimatedTokens: 90, omitted: [] },
        {
          budget: 100,
          estimatedTokens: 100,
          omitted: [{ reason: 'budget' }, { reason: 'diversity' }],
        },
      ]),
    ).toMatchObject({
      cases: 2,
      withinBudget: { numerator: 2, denominator: 2, ratio: 1 },
      selectedTokens: 190,
      omittedItems: 2,
      omittedByReason: { budget: 1, diversity: 1 },
    });
  });

  it('keeps lifecycle counts and rollback recovery separate', () => {
    expect(
      changeReviewWorkload({ added: 1, changed: 2, removed: 1, warnings: 0, contextDelta: 3 }),
    ).toMatchObject({
      changed: { numerator: 2, denominator: 4, ratio: 0.5 },
      warnings: 0,
      contextDelta: 3,
    });
    expect(
      rollbackEvidence({
        pointerChangeMs: 1.2,
        activeBuildId: 'a',
        expectedBuildId: 'a',
        rebuiltBuilds: 0,
      }),
    ).toMatchObject({ restored: true, rebuildAvoided: true });
  });

  it('reports expected-location coverage with raw counts', () => {
    expect(expectedLocationCoverage(3, 4)).toEqual({ numerator: 3, denominator: 4, ratio: 0.75 });
  });

  it('records first, middle, last and missing citation placement', () => {
    const locator = (relativePath: string) => ({ relativePath, lineStart: 1 });
    const matches = (citation: { relativePath: string }, expected: { relativePath: string }) =>
      citation.relativePath === expected.relativePath;
    expect(
      contextPlacement(
        [
          { citations: [locator('first'), locator('other')] },
          { citations: [locator('other'), locator('middle'), locator('other-2')] },
          { citations: [locator('other'), locator('last')] },
          { citations: [locator('other')] },
        ],
        [
          [{ relativePath: 'first' }],
          [{ relativePath: 'middle' }],
          [{ relativePath: 'last' }],
          [{ relativePath: 'missing' }],
        ],
        matches,
      ),
    ).toEqual({
      expectedLocations: 4,
      matched: { numerator: 3, denominator: 4, ratio: 0.75 },
      placementBuckets: {
        first: { numerator: 1, denominator: 3, ratio: 1 / 3 },
        middle: { numerator: 1, denominator: 3, ratio: 1 / 3 },
        last: { numerator: 1, denominator: 3, ratio: 1 / 3 },
      },
      normalizedPositionP50: 0.5,
      excluded: { missing: 1, noCitations: 0 },
    });
  });
});
