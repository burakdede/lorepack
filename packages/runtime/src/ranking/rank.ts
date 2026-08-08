import {
  type ArtifactStatus,
  type CatalogSearchHit,
  RANKING_WEIGHTS,
  type SearchHit,
} from '@lorepack/core/worker';

/**
 * The deterministic retrieval path from architecture 13.2, steps 2 to 9.
 *
 * Step 1 is the index: FTS5 hands back BM25 candidates. Step 10 is budget-aware packing,
 * which belongs to context assembly. Everything between is here, as separate pure
 * functions over plain data, for two reasons: each step is testable on its own with
 * synthetic scores, and the whole pipeline has no access to a database, a clock or a
 * random number, so the same build and the same query always produce the same page
 * (invariant 3).
 *
 * **A score is a relevance heuristic.** It is not a confidence, and it is not evidence
 * that a document is correct. Nothing here decides which of two documents is true, and
 * `authority` is a hint the user wrote down (invariant 6).
 */

export interface RankingInput {
  readonly query: string;
  readonly limit: number;
  readonly includeArchived: boolean;
  /** Artifact ids this build records as superseded by some other artifact. */
  readonly superseded: ReadonlySet<string>;
}

/** Every named contribution to a result's score, recorded so `--debug` can show it. */
export type ScoreComponents = Record<string, number>;

export interface RankedHit {
  readonly hit: CatalogSearchHit;
  readonly score: number;
  readonly components: ScoreComponents;
  readonly labels: SearchHit['labels'];
}

/** Why a candidate did not make the page. The vocabulary the omission report uses. */
export type DropReason = 'duplicate' | 'diversity' | 'superseded' | 'archived' | 'budget';

export interface RankingReport {
  readonly kept: readonly RankedHit[];
  /**
   * Everything the pipeline removed, and why.
   *
   * Search shows a page and does not have to explain what fell off the end. Context
   * assembly does: "no silent truncation anywhere" means a candidate dropped for being a
   * near-duplicate has to be nameable, or the omission report is a partial account
   * dressed as a complete one (#43).
   */
  readonly dropped: readonly { readonly ranked: RankedHit; readonly reason: DropReason }[];
}

/** The whole path, in the order architecture 13.2 lists it. */
export function rankCandidates(
  candidates: readonly CatalogSearchHit[],
  input: RankingInput,
): readonly RankedHit[] {
  return rankWithReport(candidates, input).kept;
}

/** The same path, keeping the reasons, for the caller that has to account for every one. */
export function rankWithReport(
  candidates: readonly CatalogSearchHit[],
  input: RankingInput,
): RankingReport {
  const terms = queryTerms(input.query);
  const dropped: { ranked: RankedHit; reason: DropReason }[] = [];

  const scored = candidates.map((hit) => score(hit, input, terms));

  const visible = applyVisibility(scored, input);
  const visibleIds = new Set(visible.map((entry) => entry.hit.chunkId));
  for (const entry of scored) {
    if (visibleIds.has(entry.hit.chunkId)) continue;
    dropped.push({
      ranked: entry,
      reason: entry.labels.includes('superseded') ? 'superseded' : 'archived',
    });
  }

  const deduped = removeNearDuplicates(visible);
  const dedupedIds = new Set(deduped.map((entry) => entry.hit.chunkId));
  for (const entry of visible) {
    if (!dedupedIds.has(entry.hit.chunkId)) dropped.push({ ranked: entry, reason: 'duplicate' });
  }

  const diversified = limitPerArtifact(deduped);
  const diversifiedIds = new Set(diversified.map((entry) => entry.hit.chunkId));
  for (const entry of deduped) {
    if (!diversifiedIds.has(entry.hit.chunkId))
      dropped.push({ ranked: entry, reason: 'diversity' });
  }

  const ordered = sortDeterministically(diversified);
  const kept = ordered.slice(0, input.limit);
  for (const entry of ordered.slice(input.limit)) {
    dropped.push({ ranked: entry, reason: 'budget' });
  }

  return { kept, dropped };
}

/**
 * Steps 2 to 5: the score, with every part named.
 *
 * BM25 is negative and lower is better, so it is negated into a positive base before
 * anything is added to it. The order matters and is the order of the specification:
 * additive boosts first, then the multipliers, so a multiplier scales the whole match
 * rather than only its lexical part.
 */
export function score(
  hit: CatalogSearchHit,
  input: RankingInput,
  terms: readonly string[] = queryTerms(input.query),
): RankedHit {
  const raw = Math.max(0, -hit.bm25);
  const lexical = saturate(raw);
  // Both are reported: the bounded number is what the ranking used, and the raw BM25 is
  // what the index said, which anyone comparing against another engine will want.
  const components: ScoreComponents = { lexical: round(lexical), lexicalRaw: round(raw) };

  let additive = lexical;
  const exact = exactMatchBoost(hit, input.query, terms);
  for (const [name, value] of Object.entries(exact)) {
    if (value === 0) continue;
    components[name] = round(value);
    additive += value;
  }

  const statusFactor = RANKING_WEIGHTS.status[hit.status] ?? 1;
  const authorityFactor = authorityMultiplier(hit.authority);
  const supersededFactor = input.superseded.has(hit.artifactId)
    ? RANKING_WEIGHTS.supersession.multiplier
    : 1;

  if (statusFactor !== 1) components.statusFactor = statusFactor;
  if (authorityFactor !== 1) components.authorityFactor = round(authorityFactor);
  if (supersededFactor !== 1) components.supersededFactor = supersededFactor;

  const total = additive * statusFactor * authorityFactor * supersededFactor;
  components.total = round(total);

  return { hit, score: round(total), components, labels: labelsFor(hit, input.superseded) };
}

/** Step 2. Exact matches on what a document is called, rather than on what it contains. */
export function exactMatchBoost(
  hit: CatalogSearchHit,
  query: string,
  terms: readonly string[] = queryTerms(query),
): ScoreComponents {
  const normalized = normalize(query);
  const basename = hit.relativePath.split('/').at(-1) ?? '';
  const withoutExtension = basename.replace(/\.[^.]+$/, '');
  const boosts = RANKING_WEIGHTS.exactMatch;

  const pathExact =
    normalized !== '' &&
    (normalize(basename) === normalized || normalize(withoutExtension) === normalized)
      ? boosts.path
      : 0;
  const titleExact =
    normalized !== '' && normalize(hit.title ?? '') === normalized ? boosts.title : 0;
  const headingExact = hit.headingPath.some((heading) => normalize(heading) === normalized)
    ? boosts.heading
    : 0;

  // Every term present, in any order. Weak on its own, and it is what separates a chunk
  // that happens to contain one common word from one that covers the whole question.
  const haystack = normalize(`${hit.relativePath} ${hit.headingPath.join(' ')} ${hit.text ?? ''}`);
  const allTerms =
    terms.length > 1 && terms.every((term) => haystack.includes(term)) ? boosts.allTerms : 0;

  return { pathExact, titleExact, headingExact, allTerms };
}

/** Step 4. Declared authority, as a narrow multiplier centred on the default. */
export function authorityMultiplier(authority: number): number {
  const { minimum, maximum, neutral } = RANKING_WEIGHTS.authority;
  const clamped = Math.max(0, Math.min(100, authority));
  // Two straight lines meeting at the neutral point, so the default declares nothing.
  if (clamped >= neutral) {
    return 1 + ((clamped - neutral) / (100 - neutral)) * (maximum - 1);
  }
  return minimum + (clamped / neutral) * (1 - minimum);
}

/**
 * Steps 3 and 5, as visibility rather than as score.
 *
 * Archived sources are excluded by default and surface as a fallback when nothing active
 * matched, which is architecture 12.7 exactly: "searchable only when requested or when no
 * active source satisfies the query". Superseded sources are suppressed from default
 * results and remain readable, so they come back only when archived ones are asked for.
 */
export function applyVisibility(
  scored: readonly RankedHit[],
  input: RankingInput,
): readonly RankedHit[] {
  if (input.includeArchived) return scored;

  const isSuppressed = (ranked: RankedHit): boolean =>
    ranked.hit.status === 'archived' || input.superseded.has(ranked.hit.artifactId);

  const visible = scored.filter((ranked) => !isSuppressed(ranked));
  if (visible.length > 0) return visible;

  // Nothing active matched. Falling back is better than an empty page, and the label is
  // what keeps it honest: a reader can see the answer came from an archived source.
  return scored;
}

/**
 * Step 8. Near-duplicate removal by a deterministic signature.
 *
 * Word shingles and Jaccard overlap, not an embedding: the same inputs must always produce
 * the same page, and a model download would break the zero-surprise install (invariant 7).
 * The better-scoring chunk of a duplicate pair survives.
 */
export function removeNearDuplicates(scored: readonly RankedHit[]): readonly RankedHit[] {
  const ordered = sortDeterministically(scored);
  const threshold = RANKING_WEIGHTS.diversity.nearDuplicateOverlap;
  const kept: RankedHit[] = [];
  /** Kept signatures indexed by size, which is what makes the prefilter below cheap. */
  const bySize = new Map<number, Array<ReadonlySet<string>>>();

  for (const ranked of ordered) {
    const signature = shingles(ranked.hit.text ?? ranked.hit.excerpt);

    // An exact prefilter, not an approximation. Jaccard overlap is bounded above by
    // min(|A|,|B|) / max(|A|,|B|), so two sets whose sizes differ by more than the
    // threshold cannot possibly reach it and never need comparing. Comparing every pair
    // is quadratic and dominated context assembly: 41 ms of a 45 ms bundle at 216
    // candidates, and it grows with the square of the candidate cap.
    const smallest = Math.ceil(signature.size * threshold);
    const largest = Math.floor(signature.size / threshold);

    let duplicate = false;
    for (let size = smallest; size <= largest && !duplicate; size += 1) {
      for (const seen of bySize.get(size) ?? []) {
        if (isNearDuplicate(seen, signature, threshold)) {
          duplicate = true;
          break;
        }
      }
    }
    if (duplicate) continue;

    kept.push(ranked);
    const bucket = bySize.get(signature.size);
    if (bucket === undefined) bySize.set(signature.size, [signature]);
    else bucket.push(signature);
  }
  return kept;
}

/** Step 9. One document may not be the whole answer. */
export function limitPerArtifact(scored: readonly RankedHit[]): readonly RankedHit[] {
  const perArtifact = new Map<string, number>();
  const kept: RankedHit[] = [];

  for (const ranked of sortDeterministically(scored)) {
    const used = perArtifact.get(ranked.hit.artifactId) ?? 0;
    if (used >= RANKING_WEIGHTS.diversity.maxChunksPerArtifact) continue;
    perArtifact.set(ranked.hit.artifactId, used + 1);
    kept.push(ranked);
  }
  return kept;
}

/**
 * Score first, then canonical path, then chunk id.
 *
 * The tie-break is the point. Two chunks with identical scores must come back in the same
 * order on every machine and every run, or an identical build would answer an identical
 * query differently and no caller could cache anything.
 */
export function sortDeterministically(scored: readonly RankedHit[]): readonly RankedHit[] {
  return [...scored].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.hit.relativePath !== right.hit.relativePath) {
      return left.hit.relativePath < right.hit.relativePath ? -1 : 1;
    }
    return left.hit.chunkId < right.hit.chunkId ? -1 : left.hit.chunkId > right.hit.chunkId ? 1 : 0;
  });
}

export function labelsFor(
  hit: { readonly status: ArtifactStatus; readonly artifactId: string },
  superseded: ReadonlySet<string>,
): SearchHit['labels'] {
  const labels: Array<'draft' | 'archived' | 'superseded'> = [];
  if (hit.status === 'draft') labels.push('draft');
  if (hit.status === 'archived') labels.push('archived');
  if (superseded.has(hit.artifactId)) labels.push('superseded');
  return labels;
}

/** Lowercased, punctuation collapsed. Shared by every comparison here. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function queryTerms(query: string): readonly string[] {
  return normalize(query).split(' ').filter(Boolean);
}

function shingles(text: string): ReadonlySet<string> {
  const words = normalize(text).split(' ').filter(Boolean);
  const size = RANKING_WEIGHTS.diversity.shingleSize;
  if (words.length <= size) return new Set(words.length === 0 ? [] : [words.join(' ')]);
  const set = new Set<string>();
  for (let i = 0; i + size <= words.length; i += 1) set.add(words.slice(i, i + size).join(' '));
  return set;
}

/**
 * Whether two shingle sets overlap by at least `threshold`, stopping as soon as the answer
 * is settled.
 *
 * The exact form is `shared / (|A| + |B| - shared) >= t`, which rearranges to a minimum
 * number of shared shingles. Once enough elements have missed that the minimum is out of
 * reach, the answer is no and the rest of the set does not need examining.
 *
 * This is the difference between a bundle that costs 37 ms and one that costs 4 ms at 216
 * candidates, and the gap grows with the square of the candidate cap. Most pairs are not
 * near-duplicates, and most of those are settled after a handful of misses.
 */
export function isNearDuplicate(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
  threshold: number,
): boolean {
  if (left.size === 0 || right.size === 0) return false;

  const needed = Math.ceil((threshold * (left.size + right.size)) / (1 + threshold));
  if (needed > Math.min(left.size, right.size)) return false;

  let shared = 0;
  let remaining = right.size;
  for (const value of right) {
    if (left.has(value)) shared += 1;
    remaining -= 1;
    if (shared >= needed) return true;
    if (shared + remaining < needed) return false;
  }
  return shared >= needed;
}

/** Jaccard overlap, for the tests that assert the measure itself rather than the decision. */
export function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const value of right) if (left.has(value)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Maps an unbounded, corpus-dependent BM25 onto [0, 1) so the boosts mean the same thing
 * everywhere. Monotone, so a better lexical match never ranks lower for being scaled.
 */
export function saturate(raw: number): number {
  const { saturation } = RANKING_WEIGHTS.lexical;
  return raw / (raw + saturation);
}

/** Scores are reported to a fixed precision so a float tail cannot reorder a page. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
