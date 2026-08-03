import {
  type CatalogSearchHit,
  type ContextBundle,
  type ContextProfile,
  count,
  LoreError,
  type SourceLocator,
} from '@lorepack/core';
import type { DropReason, RankedHit } from '../ranking/rank.js';

/**
 * Task-aware context assembly: architecture 13.3.
 *
 * This is the capability that makes Lorepack something other than a search endpoint. It
 * returns a bounded bundle, every item cited, and a complete account of what was left out
 * and why. The account is the part that matters: a bundle that quietly dropped half the
 * corpus would look identical to one that had nothing else to give.
 *
 * Two things this must never do (architecture 13.3, 13.4):
 *
 * - **Generate an answer.** Nothing here writes prose. Every character in the bundle came
 *   out of a document the user wrote, with a locator saying where.
 * - **Claim a conflict.** Alternatives are listed with their declared labels and nothing
 *   more. Lorepack does not decide which of two documents is correct (invariant 6).
 */

/** Architecture 13.5. `contextForTask` defaults to `agent`; `lore export` passes `chat`. */
export const PROFILE_BUDGETS: Readonly<Record<ContextProfile, number>> = {
  agent: 12_000,
  coding: 16_000,
  chat: 24_000,
  deep: 40_000,
};

export const DEFAULT_PROFILE: ContextProfile = 'agent';

/**
 * The range a budget may take without saying so explicitly (architecture 5.4).
 *
 * Every profile budget sits inside it. Below the floor a bundle is too small to orient an
 * agent and still say anything; above the ceiling it stops being bounded context and
 * becomes a different problem, on a machine whose limits nobody measured. Going outside is
 * allowed and is a deliberate act, not a typo that succeeds.
 */
export const SUPPORTED_BUDGET = { minimum: 4000, maximum: 40_000 } as const;

/**
 * The share of the budget held back for orientation before packing.
 *
 * Orientation is real located content, not a written summary: the opening chunk of each of
 * the most relevant documents, so an agent can see what kind of corpus it is reading. A
 * generated blurb would have no locator, and provenance is mandatory on every item in the
 * bundle (architecture 10.8), so there is nowhere honest to put one.
 */
export const ORIENTATION_SHARE = 0.1;

/** Beyond this, one artifact stops filling the bundle unless the task names it. */
export const MAX_ITEMS_PER_ARTIFACT = 4;

/** How many alternatives to list. Enough to show there was a choice, not a second bundle. */
export const MAX_ALTERNATIVES = 5;

export interface AssembleInput {
  readonly task: string;
  readonly profile: ContextProfile;
  readonly budget: number;
  /** Ranked candidates, best first, already filtered for visibility. */
  readonly ranked: readonly RankedHit[];
  /**
   * What the ranking pipeline removed, with its reason.
   *
   * Passed in rather than recomputed, because the omission report has to account for every
   * candidate the pipeline saw. A near-duplicate dropped before assembly ever ran is still
   * a thing this bundle does not contain, and a report that omitted it would be a partial
   * account dressed as a complete one.
   */
  readonly dropped: readonly { readonly ranked: RankedHit; readonly reason: DropReason }[];
  /** Suppressed candidates, offered as alternatives with their labels and nothing more. */
  readonly suppressed: readonly RankedHit[];
}

type Assembled = Pick<
  ContextBundle,
  | 'task'
  | 'profile'
  | 'budget'
  | 'estimatedTokens'
  | 'reservedTokens'
  | 'overview'
  | 'selected'
  | 'tables'
  | 'alternatives'
  | 'omitted'
  | 'citations'
>;

export function assembleBundle(input: AssembleInput): Assembled {
  const reserve = Math.floor(input.budget * ORIENTATION_SHARE);
  const targeted = targetsOneArtifact(input.task, input.ranked);

  const overview = selectOverview(input.ranked, reserve);
  const overviewIds = new Set(overview.map((item) => item.chunkId));
  const reservedTokens = overview.reduce((sum, item) => sum + item.estimatedTokens, 0);

  const selected: ContextBundle['selected'] = [];
  const omitted: ContextBundle['omitted'] = [];
  const perArtifact = new Map<string, number>();
  let used = reservedTokens;
  let budgetExhausted = false;

  for (const ranked of input.ranked) {
    if (overviewIds.has(ranked.hit.chunkId)) continue;

    const tokens = ranked.hit.estimatedTokens;
    const fromThisArtifact = perArtifact.get(ranked.hit.artifactId) ?? 0;

    if (!targeted && fromThisArtifact >= MAX_ITEMS_PER_ARTIFACT) {
      omitted.push(omit(ranked, 'diversity'));
      continue;
    }
    // Once the budget is gone every remaining candidate is omitted for budget, rather than
    // skipping the large ones and squeezing in small ones. Order in equals order out, and
    // a bundle that reordered itself to fit would be harder to reason about than one that
    // stops.
    if (budgetExhausted || used + tokens > input.budget) {
      budgetExhausted = true;
      omitted.push(omit(ranked, 'budget'));
      continue;
    }

    selected.push(toItem(ranked));
    perArtifact.set(ranked.hit.artifactId, fromThisArtifact + 1);
    used += tokens;
  }

  // Alternatives come from what ranking suppressed: drafts, archived and superseded
  // sources, listed with their labels and nothing said about which is right (13.4).
  const offered = new Set<string>();
  const alternatives = input.suppressed.slice(0, MAX_ALTERNATIVES).map((ranked) => {
    offered.add(ranked.hit.chunkId);
    return toItem(ranked);
  });
  for (const ranked of input.suppressed.slice(MAX_ALTERNATIVES)) {
    omitted.push(omit(ranked, reasonFor(ranked)));
  }

  // Everything the ranking pipeline removed before assembly saw it. Without this the
  // report would silently exclude every near-duplicate and every chunk beyond the
  // per-artifact cap, which is exactly the silent truncation the ticket forbids.
  const accounted = new Set([
    ...overview.map((item) => item.chunkId),
    ...selected.map((item) => item.chunkId),
    ...omitted.map((item) => item.chunkId),
    ...offered,
  ]);
  for (const { ranked, reason } of input.dropped) {
    if (accounted.has(ranked.hit.chunkId)) continue;
    accounted.add(ranked.hit.chunkId);
    omitted.push(omit(ranked, reason === 'budget' ? 'budget' : reason));
  }

  const citations = [...overview, ...selected].map((item) => item.locator);

  return {
    task: input.task,
    profile: input.profile,
    budget: input.budget,
    estimatedTokens: used,
    reservedTokens,
    overview,
    selected,
    // Typed tables arrive in Phase 5. The field is present and empty rather than absent,
    // so a client written now does not change shape when they land.
    tables: [],
    alternatives,
    omitted,
    citations,
  };
}

/**
 * Orientation: the opening of each of the most relevant documents.
 *
 * One item per artifact, best artifact first, until the reserve is spent. The opening of a
 * document is what tells a reader what the document is, which is the job the reserve
 * exists for, and it is real content with a real locator.
 */
function selectOverview(ranked: readonly RankedHit[], reserve: number): ContextBundle['overview'] {
  const chosen: ContextBundle['overview'] = [];
  const seen = new Set<string>();
  let used = 0;

  for (const candidate of ranked) {
    if (seen.has(candidate.hit.artifactId)) continue;
    const tokens = candidate.hit.estimatedTokens;
    if (used + tokens > reserve) continue;
    seen.add(candidate.hit.artifactId);
    chosen.push(toItem(candidate));
    used += tokens;
  }
  return chosen;
}

/**
 * Whether the task names one document, in which case the per-artifact cap is lifted.
 *
 * "avoid overfilling from one artifact **unless the task clearly targets it**"
 * (architecture 13.3). Clearly targeting means naming it: the task contains the file's
 * name, or its title. Anything looser would make the cap unpredictable.
 */
export function targetsOneArtifact(task: string, ranked: readonly RankedHit[]): boolean {
  const normalized = task.toLowerCase();
  const named = new Set<string>();

  for (const candidate of ranked) {
    const basename = candidate.hit.relativePath.split('/').at(-1) ?? '';
    const withoutExtension = basename.replace(/\.[^.]+$/, '').toLowerCase();
    const title = (candidate.hit.title ?? '').toLowerCase();
    if (withoutExtension.length > 2 && normalized.includes(withoutExtension)) {
      named.add(candidate.hit.artifactId);
    } else if (title.length > 2 && normalized.includes(title)) {
      named.add(candidate.hit.artifactId);
    }
  }
  // Exactly one: a task naming two documents is not targeting either.
  return named.size === 1;
}

function toItem(ranked: RankedHit): ContextBundle['selected'][number] {
  return {
    chunkId: ranked.hit.chunkId,
    text: ranked.hit.text,
    estimatedTokens: ranked.hit.estimatedTokens,
    headingPath: [...ranked.hit.headingPath],
    labels: ranked.labels,
    locator: locatorOf(ranked.hit),
  };
}

function omit(
  ranked: RankedHit,
  reason: ContextBundle['omitted'][number]['reason'],
): ContextBundle['omitted'][number] {
  return {
    chunkId: ranked.hit.chunkId,
    reason,
    estimatedTokens: ranked.hit.estimatedTokens,
    locator: locatorOf(ranked.hit),
  };
}

function reasonFor(ranked: RankedHit): ContextBundle['omitted'][number]['reason'] {
  if (ranked.labels.includes('superseded')) return 'superseded';
  if (ranked.labels.includes('archived')) return 'archived';
  return 'filtered';
}

function locatorOf(hit: CatalogSearchHit): SourceLocator {
  return {
    artifactId: hit.artifactId,
    relativePath: hit.relativePath,
    ...(hit.headingPath.length === 0 ? {} : { headingPath: [...hit.headingPath] }),
    ...(hit.lineStart === null || hit.lineStart <= 0 ? {} : { lineStart: hit.lineStart }),
    ...(hit.lineEnd === null || hit.lineEnd <= 0 ? {} : { lineEnd: hit.lineEnd }),
  };
}

/**
 * The budget a request resolves to, and why it is allowed.
 *
 * A profile always yields a value inside the supported range. An explicit budget is the
 * user overriding that deliberately, which architecture 5.4 permits, so it is accepted up
 * to the contract's own bound and refused past it with the range named.
 */
export function resolveBudget(
  profile: ContextProfile,
  requested: number | undefined,
  allowUnsupported = false,
): number {
  if (requested === undefined) return PROFILE_BUDGETS[profile];

  const inRange = requested >= SUPPORTED_BUDGET.minimum && requested <= SUPPORTED_BUDGET.maximum;
  if (inRange || allowUnsupported) return requested;

  throw new LoreError(
    'LORE_E_INVALID_ARGUMENT',
    `A budget of ${count(requested, 'token')} is outside the supported range of ${SUPPORTED_BUDGET.minimum.toLocaleString('en-US')} to ${SUPPORTED_BUDGET.maximum.toLocaleString('en-US')}.`,
    {
      remediation:
        'Choose a budget inside that range, omit it for the profile default, or pass --allow-unsupported-budget to go outside it deliberately.',
    },
  );
}
