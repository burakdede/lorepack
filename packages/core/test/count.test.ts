import { describe, expect, it } from 'vitest';
import { count, noun } from '../src/format/count.js';

/**
 * #150. Every renderer wrote `${n} artifacts` by hand, so the CLI said "parse 1 artifacts",
 * "1 chunks" and "Removing 1 builds". One helper, tested once, instead of the same mistake
 * repeated in six files.
 */
describe('count', () => {
  it.each([
    [0, 'artifact', '0 artifacts'],
    [1, 'artifact', '1 artifact'],
    [2, 'artifact', '2 artifacts'],
  ] as const)('renders %i as %s', (total, singular, expected) => {
    expect(count(total, singular)).toBe(expected);
  });

  it('takes an explicit plural, because English does not follow the rule', () => {
    expect(count(1, 'entry', 'entries')).toBe('1 entry');
    expect(count(3, 'entry', 'entries')).toBe('3 entries');
  });

  it('groups large numbers the way the progress renderer already does', () => {
    // `Parsing 2,400/2,400` beside `2400 artifacts` would read as two different scales.
    expect(count(2400, 'artifact')).toBe('2,400 artifacts');
  });

  it('handles a multi-word noun without mangling it', () => {
    expect(count(1, 'source file')).toBe('1 source file');
    expect(count(4, 'source file')).toBe('4 source files');
  });
});

describe('noun', () => {
  it('gives the word alone, for sentences that place the number elsewhere', () => {
    expect(noun(1, 'build')).toBe('build');
    expect(noun(2, 'build')).toBe('builds');
  });
});
