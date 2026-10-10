/**
 * Bounds that apply when serving a build, not when compiling one.
 *
 * Deliberately separate from `PRODUCT_DEFAULTS.limits`. Those are compilation inputs: they
 * are part of the effective configuration, so they are hashed into the build id, and
 * adding a field to them would change the identity of every build in existence. How much
 * text one read may return decides nothing about what a build contains, so it does not
 * belong anywhere near that hash.
 */
export const RUNTIME_LIMITS = {
  /**
   * The largest normalized text a single `readSource` returns. Beyond it the result is
   * truncated and says so: a model must never receive a silently clipped document
   * (architecture 13.1).
   */
  maxSourceReadCharacters: 200_000,
} as const;

/**
 * Bounds for the read-only table query surface.
 *
 * These belong to the runtime contract rather than one storage adapter. A local SQLite
 * process and a Cloudflare Worker must reject the same unbounded result shape, even though
 * one can kill a child process and the other can only constrain the D1 statement.
 */
export const TABLE_QUERY_LIMITS = {
  defaultRows: 100,
  maxRows: 10_000,
  maxBytes: 1_000_000,
} as const;

/**
 * Bounds for a lexical query, shared by every catalog adapter.
 *
 * FTS5 work grows with the number of phrases in a MATCH, and a common term matches most of
 * the corpus. Sixty-four distinct terms is far more than a keyword search or a task
 * sentence's useful vocabulary, and small enough that the worst query a caller can send
 * stays in the same order of cost as an ordinary one (#625).
 */
export const SEARCH_QUERY_LIMITS = {
  maxDistinctTerms: 64,
} as const;
