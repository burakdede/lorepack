import { describe, expect, it } from 'vitest';
import { type Evidence, problems, runVitest } from './support/evidence.js';

const FIXTURE = 'tools/security/test/fixtures/skipped/';
const FILE = `${FIXTURE}gate.fixture.ts`;

const evidence = (tests: readonly string[], extra: Partial<Evidence> = {}): Evidence => ({
  name: 'fixture',
  path: FILE,
  tests,
  patterns: [],
  ...extra,
});

/**
 * The gate itself, run against tests that stop proving anything in each way #615 named.
 *
 * Every case here passed the first version of the suite, which only searched the test
 * source for the titles: they are all still written in the file.
 */
describe('the security gate counts only tests that ran and passed, issue 615', () => {
  const outcomes = runVitest(['gate.fixture.ts'], FIXTURE);

  it('rejects a test skipped through its describe block', () => {
    expect(
      problems(
        evidence(['a source read cannot escape the build refuses a relative traversal']),
        outcomes,
      ),
    ).toEqual([
      `${FILE}: "a source read cannot escape the build refuses a relative traversal" reported skipped, not passed`,
    ]);
  });

  it.each([
    ['conditional skips is skipped by a condition', 'skipped'],
    ['conditional skips is only a todo', 'todo'],
    ['conditional skips skips itself at run time', 'skipped'],
    ['conditional skips fails', 'failed'],
  ])('rejects "%s", which reported %s', (name, status) => {
    expect(problems(evidence([name]), outcomes)).toEqual([
      `${FILE}: "${name}" reported ${status}, not passed`,
    ]);
  });

  it('rejects a test that was deleted or renamed', () => {
    expect(problems(evidence(['conditional skips is gone']), outcomes)).toEqual([
      `${FILE}: "conditional skips is gone" was not reported`,
    ]);
  });

  it('accepts a test that passed', () => {
    expect(problems(evidence(['conditional skips passes']), outcomes)).toEqual([]);
  });

  it('accepts a skip only on a platform the allow-list names, with its reason', () => {
    const skippable = evidence(['conditional skips is skipped by a condition'], {
      skippedOn: { win32: 'a written reason' },
    });
    expect(problems(skippable, outcomes, 'win32')).toEqual([]);
    expect(problems(skippable, outcomes, 'linux')).toHaveLength(1);
  });

  it('never lets the allow-list excuse a todo or a failure', () => {
    const allowed = { skippedOn: { linux: 'a written reason' } };
    expect(
      problems(
        evidence(['conditional skips is only a todo', 'conditional skips fails'], allowed),
        outcomes,
        'linux',
      ),
    ).toHaveLength(2);
  });
});
