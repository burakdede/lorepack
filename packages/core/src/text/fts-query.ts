import { LoreError } from '../errors/lore-error.js';
import { SEARCH_QUERY_LIMITS } from '../runtime/limits.js';

/**
 * Escapes a user query for an FTS5 MATCH expression.
 *
 * Every term is quoted, so `NEAR`, `AND`, `*` and `"` are treated as text rather than as
 * syntax. Users get literal search and can never produce a syntax error; operator support
 * would be a deliberate feature with its own surface, not an accident of quoting.
 *
 * Terms the tokenizer would read as the same tokens are kept once. A repeated term is
 * idempotent under AND and redundant under OR, but FTS5 still evaluates every copy, and
 * one common word repeated a few dozen times cost minutes of CPU (#625). Past
 * `SEARCH_QUERY_LIMITS.maxDistinctTerms` the query is refused rather than truncated: a
 * silently shortened query answers a different question than the one asked.
 *
 * Shared by the local and the D1 catalog, so the same query matches the same chunks on
 * both and ranking parity holds.
 */
export function escapeFtsQuery(query: string, match: 'all' | 'any' = 'all'): string {
  const terms = new Map<string, string>();
  for (const term of query.split(/\s+/)) {
    const key = tokenKey(term);
    // A term with no token is an empty phrase, which FTS5 ignores under AND and OR alike.
    if (key === '' || terms.has(key)) continue;
    terms.set(key, term.replace(/"/g, '""'));
  }

  if (terms.size > SEARCH_QUERY_LIMITS.maxDistinctTerms) {
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      `The query has ${terms.size} distinct terms; at most ${SEARCH_QUERY_LIMITS.maxDistinctTerms} are searched.`,
      {
        remediation: `Keep the ${SEARCH_QUERY_LIMITS.maxDistinctTerms} terms that matter most and search again.`,
        details: {
          distinctTerms: terms.size,
          maxDistinctTerms: SEARCH_QUERY_LIMITS.maxDistinctTerms,
        },
      },
    );
  }

  // `all` is implicit AND, which is what a keyword search wants; `any` is what a sentence
  // wants, because a task like "how do I roll back a release" shares no chunk with all of
  // its own words.
  return [...terms.values()].map((term) => `"${term}"`).join(match === 'any' ? ' OR ' : ' ');
}

/**
 * The tokens FTS5's `unicode61` tokenizer reads from one term, as a comparison key.
 *
 * Mirrors its folding: case, diacritics, and every character outside letters, numbers and
 * private use is a separator. Canonical decomposition only, never compatibility: unicode61
 * keeps full-width letters and ligatures distinct from ASCII, and merging them here would
 * drop a constraint the caller asked for.
 */
function tokenKey(term: string): string {
  const folded = term.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  return (folded.match(/[\p{L}\p{N}\p{Co}]+/gu) ?? []).join(' ');
}
