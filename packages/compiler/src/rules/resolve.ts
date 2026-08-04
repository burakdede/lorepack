import {
  type ArtifactStatus,
  type Canonical,
  type EffectiveConfig,
  LoreError,
} from '@lorepack/core';
import picomatch from 'picomatch';

/**
 * Resolving declared rules onto artifacts.
 *
 * Architecture section 4.5 is the reason this stage exists at all: Lorepack does not detect
 * conflicts and does not decide which document is correct. A user declares precedence, and
 * this turns that declaration into per-artifact facts. Nothing here inspects content.
 *
 * `authority` is a **ranking hint**, not evidence. Two documents can disagree and Lorepack
 * will rank one above the other because it was told to, and will never say the other is
 * wrong. That distinction is the product's honesty, and it is worth restating wherever the
 * word `authority` appears.
 *
 * The resolution runs after discovery and before indexing (section 12.7), and its output is
 * an input to the build id (section 11.4), so editing a rule produces a different build.
 */

/**
 * Reuses the canonical status set rather than declaring one.
 *
 * There is no `deprecated`: the schema has three statuses, the catalog stores three, and the
 * ranking weights are defined for three. A resolver that accepted a fourth would produce
 * builds the rest of the system cannot represent, and the failure would appear at write time
 * rather than at the configuration a user can fix.
 */
export type RuleStatus = ArtifactStatus;

export interface ResolvedArtifactRule {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly status: RuleStatus;
  readonly authority: number;
  /** Artifact ids, resolved from the globs a user wrote. Sorted, deduplicated. */
  readonly supersedes: readonly string[];
  /** Indices into the configured rule list, in the order they applied (section 10.6). */
  readonly matchedRules: readonly number[];
}

/** What a parser produced, before rules had anything to say about it. */
export interface RuleInput {
  readonly artifactId: string;
  readonly relativePath: string;
}

export interface RuleResolution {
  readonly resolved: readonly ResolvedArtifactRule[];
  /** Rules that matched nothing. An error under `strictRules`, a warning otherwise. */
  readonly warnings: readonly {
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }[];
  /**
   * The canonical form that feeds `deriveBuildId`.
   *
   * Deliberately not the whole resolution: it carries what a rule *decided*, so that two
   * builds differing only in a rule's effect differ in identity, and two builds whose rules
   * are written differently but resolve identically do not. A user reordering rules without
   * changing their outcome should not rebuild the world.
   */
  readonly canonical: Canonical;
}

const DEFAULT_STATUS: RuleStatus = 'active';
const DEFAULT_AUTHORITY = 50;
const STATUSES = new Set<string>(['active', 'draft', 'archived']);

export function resolveRules(options: {
  readonly artifacts: readonly RuleInput[];
  readonly config: Pick<EffectiveConfig, 'rules' | 'strictRules'>;
}): RuleResolution {
  const { artifacts, config } = options;
  const rules = config.rules;

  assertRuleValues(rules);

  // Compiled once and reused across every artifact: at the 2,500-file envelope with a dozen
  // rules this is 30,000 match calls, and compiling the glob inside the loop dominates.
  const matchers = rules.map((rule) => picomatch(rule.match, { dot: true }));

  const unmatched: number[] = [];
  const resolved: ResolvedArtifactRule[] = [];

  for (let index = 0; index < rules.length; index += 1) {
    const matches = matchers[index] as picomatch.Matcher;
    if (!artifacts.some((artifact) => matches(artifact.relativePath))) unmatched.push(index);
  }
  assertRulesMatched(unmatched, rules, config.strictRules);

  for (const artifact of artifacts) {
    let status: RuleStatus = DEFAULT_STATUS;
    let authority = DEFAULT_AUTHORITY;
    let supersedes: string[] = [];
    const matchedRules: number[] = [];

    for (const [index, rule] of rules.entries()) {
      if (!(matchers[index] as picomatch.Matcher)(artifact.relativePath)) continue;
      matchedRules.push(index);

      // Later rules win on scalars, which is section 12.7's ordering and the behaviour a
      // reader expects from a list they wrote top to bottom.
      if (rule.status !== undefined) status = rule.status as RuleStatus;
      if (rule.authority !== undefined) authority = rule.authority;

      if (rule.supersedes !== undefined) {
        const targets = resolveTargets(rule.supersedes, artifacts, artifact.artifactId, {
          ruleIndex: index,
          match: rule.match,
          relativePath: artifact.relativePath,
        });
        // Lists **merge** by default and replace only when asked. A user writing two rules
        // that each name something superseded means both, and silently dropping the first
        // would be the kind of quiet loss this project refuses everywhere else.
        supersedes = rule.replace === true ? targets : [...supersedes, ...targets];
      }
    }

    resolved.push({
      artifactId: artifact.artifactId,
      relativePath: artifact.relativePath,
      status,
      authority,
      supersedes: [...new Set(supersedes)].sort(),
      matchedRules,
    });
  }

  assertNoCycle(resolved);

  return {
    resolved,
    warnings: unmatched.map((index) => ({
      code: 'rule-matched-nothing',
      path: rules[index]?.match ?? '?',
      message: `The rule matching \`${rules[index]?.match ?? '?'}\` applied to no file, so it had no effect. Turn on strictRules to make this an error.`,
    })),
    canonical: canonicalize(resolved),
  };
}

/**
 * Globs on the left of `supersedes` name **paths**, and the output is artifact ids.
 *
 * A user writes what they see, which is a path. Everything downstream addresses artifacts by
 * id, and translating here means the id never has to be guessed later, and a superseded target
 * that no longer exists is caught at build time rather than at query time.
 *
 * An artifact never supersedes itself. A glob like `docs/**` written on a rule that also
 * matches `docs/**` would otherwise make every document supersede itself, which resolves to a
 * cycle of length one and fails the build for what is obviously a broad glob rather than a
 * mistake.
 */
function resolveTargets(
  globs: readonly string[],
  artifacts: readonly RuleInput[],
  selfId: string,
  where: { ruleIndex: number; match: string; relativePath: string },
): string[] {
  const targets: string[] = [];
  for (const glob of globs) {
    const isMatch = picomatch(glob, { dot: true });
    let matched = 0;
    for (const artifact of artifacts) {
      if (artifact.artifactId === selfId) continue;
      if (!isMatch(artifact.relativePath)) continue;
      matched += 1;
      targets.push(artifact.artifactId);
    }
    // A pattern that names nothing is the "missing superseded target" case, and it has to be
    // caught here rather than downstream: globs resolve against the artifacts that exist, so
    // a pattern matching nothing produces an empty list that looks exactly like a rule with
    // no `supersedes` at all. The user asserted a relationship to something; saying nothing
    // would leave them believing a document had been superseded when it had not.
    if (matched === 0) {
      throw new LoreError(
        'LORE_E_CONFIG_INVALID',
        `Rule ${String(where.ruleIndex + 1)} (${where.match}) says ${where.relativePath} supersedes \`${glob}\`, which matches no file in this build.`,
        {
          remediation:
            'Check the pattern. A superseded file has to be part of the build: excluding it and superseding it are different statements, and only one of them can be true.',
          path: where.relativePath,
          subject: glob,
        },
      );
    }
  }
  return targets;
}

function assertRuleValues(rules: EffectiveConfig['rules']): void {
  for (const [index, rule] of rules.entries()) {
    if (rule.status !== undefined && !STATUSES.has(rule.status)) {
      throw new LoreError(
        'LORE_E_CONFIG_INVALID',
        `Rule ${String(index + 1)} (${rule.match}) has status "${rule.status}".`,
        {
          remediation: `Use one of ${[...STATUSES].sort().join(', ')}.`,
          subject: rule.match,
        },
      );
    }
    if (rule.authority !== undefined && (rule.authority < 0 || rule.authority > 100)) {
      throw new LoreError(
        'LORE_E_CONFIG_INVALID',
        `Rule ${String(index + 1)} (${rule.match}) sets authority to ${String(rule.authority)}.`,
        {
          remediation:
            'Authority is 0 to 100. It is a ranking hint you declare, not a measurement, so the scale is whatever you decide it means.',
          subject: rule.match,
        },
      );
    }
  }
}

/**
 * A rule that matches nothing, which is a typo far more often than an intention.
 *
 * A warning by default and a failure under `strictRules`, because the cost of being wrong
 * differs: on a personal project a stale rule is noise, and in CI it means the precedence
 * someone thought they had configured is not in effect and nothing said so.
 */
function assertRulesMatched(
  unmatched: readonly number[],
  rules: EffectiveConfig['rules'],
  strict: boolean,
): void {
  if (unmatched.length === 0 || !strict) return;
  const named = unmatched.map((index) => `${String(index + 1)} (${rules[index]?.match ?? '?'})`);
  throw new LoreError(
    'LORE_E_CONFIG_INVALID',
    `These rules matched no file: ${named.join(', ')}.`,
    {
      remediation:
        'Fix the pattern or remove the rule. `strictRules` is on, which is what turns a rule that does nothing into an error rather than a warning.',
    },
  );
}

/**
 * A supersession cycle, refused with the whole path named.
 *
 * Two documents each claiming to replace the other is not a state Lorepack can resolve, and
 * picking one would be exactly the invented truth section 4.5 forbids. The message walks the
 * cycle so the user can see which declaration to remove, rather than being told a cycle
 * exists somewhere in their configuration.
 */
function assertNoCycle(resolved: readonly ResolvedArtifactRule[]): void {
  const edges = new Map(resolved.map((entry) => [entry.artifactId, entry.supersedes]));
  const pathOf = new Map(resolved.map((entry) => [entry.artifactId, entry.relativePath]));
  const state = new Map<string, 'visiting' | 'done'>();

  const walk = (id: string, trail: string[]): void => {
    const seen = state.get(id);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      const from = trail.indexOf(id);
      const cycle = [...trail.slice(from), id].map((one) => pathOf.get(one) ?? one);
      throw new LoreError(
        'LORE_E_CONFIG_INVALID',
        `These files supersede each other in a loop: ${cycle.join(' -> ')}.`,
        {
          remediation:
            'Remove one of the supersedes declarations. Lorepack cannot decide which of two documents replaces the other, and will not guess.',
          path: cycle[0] as string,
        },
      );
    }
    state.set(id, 'visiting');
    for (const next of edges.get(id) ?? []) walk(next, [...trail, id]);
    state.set(id, 'done');
  };

  for (const entry of resolved) walk(entry.artifactId, []);
}

/**
 * What the build id sees.
 *
 * Sorted by artifact id, and carrying only the decided values. `matchedRules` is deliberately
 * excluded: it is attribution for a human reading `lore inspect rules`, and including it would
 * make reordering two rules that both set the same status change the build id, which is a
 * rebuild for no difference in what the build contains.
 */
function canonicalize(resolved: readonly ResolvedArtifactRule[]): Canonical {
  return [...resolved]
    .sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0))
    .filter(
      (entry) =>
        entry.status !== DEFAULT_STATUS ||
        entry.authority !== DEFAULT_AUTHORITY ||
        entry.supersedes.length > 0,
    )
    .map((entry) => [
      entry.artifactId,
      entry.status,
      entry.authority,
      [...entry.supersedes],
    ]) as unknown as Canonical;
}
