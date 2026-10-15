import { LoreError } from '@lorepack/core';
import { expect, it } from 'vitest';
import { type CoverageArtifact, checkRequiredCoverage } from '../src/required/coverage.js';

const path = 'docs/budget.xlsx';
const complete: CoverageArtifact = {
  artifact: { displayPath: path },
  nodes: [{ kind: 'sheet', metadata: { sheet: 'Revenue', imported: true } }],
};

it('names a missing required artifact in permissive diagnostics', () => {
  expect(checkRequiredCoverage({ profile: 'permissive', required: [{ path }] }, [])).toEqual([
    expect.objectContaining({ code: 'required-source-unavailable', path }),
  ]);
});

it('fails strict coverage with a stable build error and structured failures', () => {
  try {
    checkRequiredCoverage({ profile: 'strict', required: [{ path }] }, []);
    expect.unreachable('Missing required input was accepted');
  } catch (error) {
    expect(error).toBeInstanceOf(LoreError);
    expect(error).toMatchObject({
      code: 'LORE_E_REQUIRED_COVERAGE',
      exitCode: 2,
      path,
      details: {
        failures: [expect.objectContaining({ code: 'required-source-unavailable', path })],
      },
    });
  }
});

it('requires the exact project-relative path, not the same basename in another source', () => {
  expect(
    checkRequiredCoverage({ profile: 'permissive', required: [{ path: 'other/budget.xlsx' }] }, [
      complete,
    ]),
  ).toHaveLength(1);
});

it('matches a canonical declaration to a decomposed filesystem display path', () => {
  expect(
    checkRequiredCoverage({ profile: 'strict', required: [{ path: 'docs/café.xlsx' }] }, [
      { ...complete, artifact: { displayPath: 'docs/cafe\u0301.xlsx' } },
    ]),
  ).toEqual([]);
});

it('does not turn informational parser warnings into extraction loss', () => {
  expect(
    checkRequiredCoverage({ profile: 'strict', required: [{ path }] }, [
      {
        ...complete,
        warnings: [{ code: 'xlsx-1904-dates', message: 'Dates converted from 1904.' }],
      },
    ]),
  ).toEqual([]);
});

it('does not reject loss in an input the project has not declared required', () => {
  expect(
    checkRequiredCoverage({ profile: 'strict', required: [] }, [
      {
        ...complete,
        warnings: [
          {
            code: 'xlsx-preamble-skipped',
            message: 'Preamble omitted.',
            loss: { sheet: 'Revenue' },
          },
        ],
      },
    ]),
  ).toEqual([]);
});

it.each([undefined, false])(
  'rejects a required sheet without confirmed imported data: %s',
  (imported) => {
    const nodes: CoverageArtifact['nodes'] =
      imported === undefined ? [] : [{ kind: 'sheet', metadata: { sheet: 'Revenue', imported } }];
    expect(
      checkRequiredCoverage({ profile: 'permissive', required: [{ path, sheets: ['Revenue'] }] }, [
        { ...complete, nodes },
      ]),
    ).toEqual([
      expect.objectContaining({
        code: 'required-sheet-unavailable',
        message: expect.stringContaining('Revenue'),
      }),
    ]);
  },
);

it('does not reject a required sheet for known loss in a different sheet', () => {
  expect(
    checkRequiredCoverage({ profile: 'strict', required: [{ path, sheets: ['Revenue'] }] }, [
      {
        ...complete,
        warnings: [{ code: 'xlsx-no-table', message: 'Notes omitted.', loss: { sheet: 'Notes' } }],
      },
    ]),
  ).toEqual([]);
});

it.each([{ sheet: 'Revenue' }, {}])('reports matching sheet or artifact-wide loss: %j', (loss) => {
  expect(
    checkRequiredCoverage({ profile: 'permissive', required: [{ path, sheets: ['Revenue'] }] }, [
      { ...complete, warnings: [{ code: 'known-loss', message: 'Content omitted.', loss }] },
    ]),
  ).toEqual([
    expect.objectContaining({
      code: 'required-source-incomplete',
      message: expect.stringContaining('Content omitted.'),
    }),
  ]);
});

it('requires all known worksheet coverage when the complete workbook is declared', () => {
  expect(() =>
    checkRequiredCoverage({ profile: 'strict', required: [{ path }] }, [
      {
        ...complete,
        warnings: [{ code: 'xlsx-no-table', message: 'Notes omitted.', loss: { sheet: 'Notes' } }],
      },
    ]),
  ).toThrow(LoreError);
});
