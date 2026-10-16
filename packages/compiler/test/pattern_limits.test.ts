import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { createMatcher, parseIgnoreFile } from '../src/discover/ignore.js';
import { resolveRules } from '../src/rules/resolve.js';

const repeated = 'a*a*a*a*a*a*a*a*a*a*a*a*a*z';
const invalid = expect.objectContaining({ code: 'LORE_E_CONFIG_INVALID' });

it('rejects the recorded repeated-star ignore pattern before matching', () => {
  const started = performance.now();
  expect(() => parseIgnoreFile(`# comment\n\n${repeated}\n`, '.loreignore')).toThrowError(
    expect.objectContaining({
      code: 'LORE_E_CONFIG_INVALID',
      path: '.loreignore',
      message: expect.stringMatching(/line 3/),
    }),
  );
  expect(performance.now() - started).toBeLessThan(1000);
});

it.each([repeated, 'a'.repeat(513), `!${repeated}`, `folder/${repeated}/`])(
  'rejects invalid ignore input %s',
  (pattern) => expect(() => parseIgnoreFile(pattern, '.loreignore')).toThrowError(invalid),
);

it('validates direct matcher rules before compiling them', () => {
  expect(() =>
    createMatcher([{ pattern: repeated, source: 'direct rule', negated: false }]),
  ).toThrowError(invalid);
});

it.each(['match', 'supersedes'] as const)(
  'validates direct resolver %s even with no matching artifacts',
  (field) => {
    const rule =
      field === 'match'
        ? { match: repeated, authority: 80 }
        : { match: '*.md', supersedes: [repeated] };
    expect(() =>
      resolveRules({ artifacts: [], config: { rules: [rule], strictRules: false } }),
    ).toThrowError(invalid);
  },
);

it('retains directory pruning, negation and admitted glob semantics', () => {
  const matcher = createMatcher(
    parseIgnoreFile('private/\ndrafts/**\n!drafts/keep.md\n', '.loreignore'),
  );
  expect(matcher.decideDirectory('private')?.pattern).toBe('private/');
  expect(matcher.excludes('drafts/hidden.md')).toBe(true);
  expect(matcher.excludes('drafts/keep.md')).toBe(false);
  expect(matcher.excludes('public/a.md')).toBe(false);
});

it('applies the ignore budget after portable separator normalization', () => {
  const pattern = 'one*\\two*\\three*\\four*\\five*';
  const matcher = createMatcher(parseIgnoreFile(pattern, '.loreignore'));
  expect(matcher.excludes('one-a/two-b/three-c/four-d/five-e')).toBe(true);
});
