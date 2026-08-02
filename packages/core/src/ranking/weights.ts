/**
 * Every number that decides an ordering, in one place.
 *
 * Architecture 12.9 keeps ranking weights out of stored data: baking them into the index
 * would make retuning ranking a rebuild, and would mean two builds of the same sources
 * disagreeing because they were compiled by differently tuned compilers. They live here,
 * in the portable package, because two things need them and neither may import the other:
 * the FTS5 query inside the local backend applies the column weights, and the runtime
 * applies the boosts. One table, one diff, one version.
 *
 * **None of these numbers is a claim about truth.** `authority` is a hint the user wrote
 * down, and a score is a relevance heuristic. Lorepack must never present either as
 * evidence that a document is correct (invariant 6, architecture 4.5).
 */

/**
 * Bumped whenever a weight changes, so a benchmark or a fixture expectation can say which
 * tuning it was recorded against rather than silently drifting.
 */
export const RANKING_WEIGHTS_VERSION = 1;

export const RANKING_WEIGHTS = {
  /**
   * `bm25()` column weights, in the column order of `chunks_fts` (architecture 12.9):
   * chunk_id, artifact_id, status, authority, path, title, heading, body.
   *
   * The four unindexed columns take zero because they carry identifiers, not prose. Title
   * outranks path outranks heading outranks body: a term in a document's title is a much
   * stronger signal about the document than the same term buried in its text.
   */
  columns: {
    chunkId: 0,
    artifactId: 0,
    status: 0,
    authority: 0,
    path: 4,
    title: 6,
    heading: 3,
    body: 1,
  },

  /**
   * Turns BM25 into a bounded number, so every other weight here means the same thing on
   * every corpus.
   *
   * Raw BM25 is not comparable across corpora, and the difference is not small. Measured
   * on this project: a query for a term that appears in every document scores about
   * 0.000002, because a word that is everywhere carries no information, while the same
   * query shape over 400 documents of varied prose scores about 5.4. Adding a fixed boost
   * of 3 to both means the boost is decorative in one corpus and decisive in the other,
   * which makes the weights untunable and the debug output impossible to read.
   *
   * `lexical = raw / (raw + saturation)` maps [0, infinity) onto [0, 1): saturating, so a
   * spectacular lexical match cannot drown every other signal, and monotone, so a better
   * match never ranks lower. At the saturation point the lexical component is exactly 0.5.
   */
  lexical: {
    saturation: 6,
  },

  /**
   * Added to the bounded lexical score when the query names something exactly.
   *
   * Additive rather than multiplicative so a document with no lexical match at all cannot
   * be lifted into the results by its filename alone, and so the debug output can show a
   * boost as the number of points it contributed. They are on the same 0 to 1 scale as
   * the lexical component, and sized to decide a close contest rather than to win any
   * contest: a document titled for the query beats a comparable match, because that is
   * what a person means by typing a name, and loses to a section that covers the subject
   * in depth, because a title is a label and the deeper match is more likely the answer.
   */
  exactMatch: {
    /** The query is exactly the file's basename, with or without extension. */
    path: 0.25,
    /** The query is exactly the artifact's title. */
    title: 0.35,
    /** The query is exactly one heading in the chunk's ancestry. */
    heading: 0.15,
    /** Every query term appears somewhere in the chunk, in any order. */
    allTerms: 0.08,
  },

  /**
   * Multipliers by declared status (architecture 12.7). A draft is penalised and labelled;
   * an archived source is excluded by default and only surfaces when asked for, or when
   * nothing active matched at all, so its multiplier applies to a fallback result.
   */
  status: {
    active: 1,
    draft: 0.6,
    archived: 0.4,
  },

  /**
   * Authority is declared 0 to 100 and defaults to 50, so the multiplier is centred on 1
   * at the default and spans a deliberately narrow range. A hint should be able to break a
   * tie and lose to a much better match; if authority could dominate the lexical signal,
   * it would function as a truth claim.
   */
  authority: {
    minimum: 0.75,
    maximum: 1.25,
    /** The declared value that maps to a multiplier of exactly 1. */
    neutral: 50,
  },

  /** A superseded artifact stays readable, and is suppressed from default results. */
  supersession: {
    /** Multiplier applied when a superseded source is shown anyway, on request. */
    multiplier: 0.5,
  },

  diversity: {
    /**
     * How many chunks one artifact may contribute to a page of results. One long document
     * that mentions the query in every section would otherwise be the whole answer.
     */
    maxChunksPerArtifact: 3,
    /**
     * Jaccard overlap of word shingles above which two chunks are near-duplicates. A
     * deterministic signature, not an embedding: the same inputs must always produce the
     * same page (invariant 3).
     */
    nearDuplicateOverlap: 0.85,
    shingleSize: 4,
  },

  /**
   * How many candidates to pull from the index before ranking, as a multiple of the
   * requested limit. Ranking can only reorder what it was given, so a page of 10 taken
   * straight from BM25 would make every boost decorative.
   */
  candidates: {
    multiplier: 8,
    minimum: 60,
    maximum: 500,
  },
} as const;

/** The `bm25()` weights as SQL arguments, in column order. */
export function bm25ColumnWeights(): readonly number[] {
  const { columns } = RANKING_WEIGHTS;
  return [
    columns.chunkId,
    columns.artifactId,
    columns.status,
    columns.authority,
    columns.path,
    columns.title,
    columns.heading,
    columns.body,
  ];
}

/** How many candidates to ask the index for, to rank a page of `limit`. */
export function candidateCount(limit: number): number {
  const { multiplier, minimum, maximum } = RANKING_WEIGHTS.candidates;
  return Math.min(maximum, Math.max(minimum, limit * multiplier));
}
