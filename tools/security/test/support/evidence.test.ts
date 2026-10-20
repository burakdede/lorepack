import { describe, expect, it } from 'vitest';
import { runVitest, testNamePattern } from './evidence.js';

const FIXTURE = 'tools/security/test/fixtures/skipped/';

describe('security evidence test selection', () => {
  it('runs only the named test and retains its result', () => {
    const outcomes = runVitest(
      ['gate.fixture.ts'],
      FIXTURE,
      testNamePattern(['conditional skips passes']),
    );

    const passed = outcomes.filter((outcome) => outcome.status === 'passed');
    expect(passed).toMatchObject([{ fullName: 'conditional skips passes' }]);
    expect(passed).toHaveLength(1);
  });

  it('escapes regular expression characters in declared test names', () => {
    const pattern = new RegExp(testNamePattern(['test [with] punctuation?']));

    expect('suite test [with] punctuation?').toMatch(pattern);
    expect('suite test xwithx punctuation?').not.toMatch(pattern);
  });
});
