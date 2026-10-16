import { expect, it } from 'vitest';
import { readTableEvidence } from '../src/runtime/table_evidence.js';

it('distinguishes historical unknown from recorded absence, issue430', () => {
  expect(readTableEvidence({}, 2)).toEqual({
    formulas: ['unknown', 'unknown'],
    conversionWarnings: null,
  });
  expect(
    readTableEvidence(
      { tableEvidence: { version: 1, formulaColumns: [1], conversionWarnings: [] } },
      3,
    ),
  ).toEqual({ formulas: ['absent', 'present', 'absent'], conversionWarnings: [] });
});
it.each([
  { version: 1, formulaColumns: [2], conversionWarnings: [] },
  { version: 1, formulaColumns: [1, 0], conversionWarnings: [] },
  { version: 1, formulaColumns: [1, 1], conversionWarnings: [] },
  { version: 1, formulaColumns: [-1], conversionWarnings: [] },
  { version: 1, formulaColumns: [0] },
  { version: 2, formulaColumns: [], conversionWarnings: [] },
  null,
])(
  'refuses malformed stored evidence without fabricating absence, issue430: %j',
  (tableEvidence) => {
    expect(() => readTableEvidence({ tableEvidence }, 2)).toThrow(
      expect.objectContaining({ code: 'LORE_E_OBJECT_CORRUPT' }),
    );
  },
);

it.each([null, [], 3, 'not metadata'])(
  'refuses invalid metadata containers, issue430: %j',
  (metadata) => {
    expect(() => readTableEvidence(metadata, 2)).toThrow(
      expect.objectContaining({ code: 'LORE_E_OBJECT_CORRUPT' }),
    );
  },
);
