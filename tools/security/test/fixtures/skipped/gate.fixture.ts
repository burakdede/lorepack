import { describe, expect, it } from 'vitest';

// The counterexample from #615, verbatim: the whole traversal class skipped at its describe.
// biome-ignore lint/suspicious/noSkippedTests: fixture proving the security gate rejects a skip
describe.skip('a source read cannot escape the build', () => {
  it('refuses a relative traversal', () => {
    expect(true).toBe(true);
  });
});

describe('conditional skips', () => {
  it.skipIf(true)('is skipped by a condition', () => {
    expect(true).toBe(true);
  });

  it.todo('is only a todo');

  it('skips itself at run time', (context) => {
    context.skip();
  });

  it('fails', () => {
    expect(1).toBe(2);
  });

  it('passes', () => {
    expect(true).toBe(true);
  });
});
