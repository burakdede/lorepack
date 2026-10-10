import { describe, expect, it } from 'vitest';
import { LoreError } from '../src/errors/index.js';
import { SEARCH_QUERY_LIMITS } from '../src/runtime/limits.js';
import { escapeFtsQuery } from '../src/text/fts-query.js';

describe('escapeFtsQuery', () => {
  it.each([
    ['simple query', '"simple" "query"'],
    ['with "quotes"', '"with" """quotes"""'],
    ['NEAR AND OR', '"NEAR" "AND" "OR"'],
    ['wildcard*', '"wildcard*"'],
    ['  spaced   out  ', '"spaced" "out"'],
  ])('quotes every term of %s, so nothing typed is FTS5 syntax', (input, expected) => {
    expect(escapeFtsQuery(input)).toBe(expected);
  });

  it('joins with OR when any term may match', () => {
    expect(escapeFtsQuery('roll back release', 'any')).toBe('"roll" OR "back" OR "release"');
  });

  it('produces an empty match for an empty query rather than a syntax error', () => {
    expect(escapeFtsQuery('   ')).toBe('');
    expect(escapeFtsQuery('" "" """')).toBe('');
  });

  // #625: a repeated high-frequency term made FTS5 intersect the same postings list N
  // times, which grew quadratically and hung the server on a 1,000-character query.
  describe('repeated terms, issue 625', () => {
    it('keeps one copy of a term however often it is repeated', () => {
      expect(escapeFtsQuery(Array(250).fill('a').join(' '))).toBe('"a"');
      expect(escapeFtsQuery(Array(250).fill('a').join(' '), 'any')).toBe('"a"');
    });

    it('folds case and diacritics the way the unicode61 tokenizer does', () => {
      expect(escapeFtsQuery('Rollback ROLLBACK rollback')).toBe('"Rollback"');
      expect(escapeFtsQuery('café CAFE café càfë')).toBe('"café"');
      expect(escapeFtsQuery('İstanbul istanbul')).toBe('"İstanbul"');
    });

    it('treats punctuation as the separator the tokenizer treats it as', () => {
      expect(escapeFtsQuery('a. a, a; a: a! (a) "a" a--')).toBe('"a."');
      // A phrase is still a phrase: `roll-back` is the tokens `roll back` in order, which
      // is a different question from `roll` and `back` anywhere in the chunk.
      expect(escapeFtsQuery('roll-back roll back roll.back')).toBe('"roll-back" "roll" "back"');
    });

    it('drops a term that holds no token, which FTS5 ignores anyway', () => {
      expect(escapeFtsQuery('-- hello ...')).toBe('"hello"');
      expect(escapeFtsQuery('--')).toBe('');
    });

    it('does not merge characters the tokenizer keeps apart', () => {
      // Full-width letters and ligatures are distinct tokens to unicode61, so folding them
      // into ASCII would silently drop a constraint the caller asked for.
      expect(escapeFtsQuery('ab ａｂ fix ﬁx')).toBe('"ab" "ａｂ" "fix" "ﬁx"');
    });
  });

  describe('the distinct-term cap, issue 625', () => {
    const terms = (count: number): string =>
      Array.from({ length: count }, (_, index) => `term${index}`).join(' ');

    it(`accepts exactly ${SEARCH_QUERY_LIMITS.maxDistinctTerms} distinct terms`, () => {
      const match = escapeFtsQuery(terms(SEARCH_QUERY_LIMITS.maxDistinctTerms), 'any');
      expect(match.split(' OR ')).toHaveLength(SEARCH_QUERY_LIMITS.maxDistinctTerms);
    });

    it('refuses one more with a typed invalid-argument error', () => {
      let thrown: unknown;
      try {
        escapeFtsQuery(terms(SEARCH_QUERY_LIMITS.maxDistinctTerms + 1));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(LoreError);
      expect((thrown as LoreError).code).toBe('LORE_E_INVALID_ARGUMENT');
      expect((thrown as LoreError).details).toEqual({
        distinctTerms: SEARCH_QUERY_LIMITS.maxDistinctTerms + 1,
        maxDistinctTerms: SEARCH_QUERY_LIMITS.maxDistinctTerms,
      });
    });

    it('counts terms after de-duplication, so repetition never reaches the cap', () => {
      expect(() => escapeFtsQuery(Array(1000).fill('a A a.').join(' '))).not.toThrow();
    });
  });
});
