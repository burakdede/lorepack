import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';

/**
 * Gitignore-style matching for `.loreignore`, plus the always-on exclusions.
 *
 * Chokidar removed glob support, so this matcher is the single source of truth for what
 * belongs in a build: the initial scan, the reconciliation scan and watch-event filtering
 * all call it. If they disagreed, a file would appear or disappear depending on how it was
 * noticed, which is a bug class worth designing out rather than debugging.
 */

export interface IgnoreRule {
  readonly pattern: string;
  readonly negated: boolean;
  readonly source: string;
}

export interface Matcher {
  /** True when the path is excluded. Later rules win, so a negation can re-include. */
  readonly excludes: (canonicalPath: string, isDirectory?: boolean) => boolean;
  /**
   * The rule that excludes a whole directory, so the walk can skip it entirely.
   *
   * Separate from `decide` because a pattern naming a directory's contents (`drafts/**`) is
   * not a pattern naming the directory, and pruning on the first would break a negation
   * beneath it. See the implementation for why this follows git rather than simplifying.
   */
  readonly decideDirectory: (canonicalPath: string) => IgnoreRule | null;
  /**
   * The rule that decided to exclude this path, or `null` when it is included.
   *
   * `excludes` answers the question discovery needs to act; this answers the one a reader
   * needs to act. "Not in the build" is not a useful answer when the next question is always
   * "which line of which file did that", and until #202 nothing could answer it because the
   * deciding rule was known here and discarded one frame later.
   */
  readonly decide: (canonicalPath: string) => IgnoreRule | null;
  readonly rules: readonly IgnoreRule[];
}

export function parseIgnoreFile(contents: string, source: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1).trim() : line;
    if (pattern === '') continue;
    rules.push({ pattern, negated, source });
  }
  return rules;
}

export function readIgnoreRules(projectRoot: string, filename: string): IgnoreRule[] {
  const path = join(projectRoot, filename);
  if (!existsSync(path)) return [];
  return parseIgnoreFile(readFileSync(path, 'utf8'), filename);
}

/**
 * A gitignore pattern matches at any depth unless it contains a slash, and a trailing
 * slash restricts it to directories. Expanding each pattern into the forms picomatch needs
 * keeps that behaviour without reimplementing the semantics.
 *
 * Git anchors a pattern when a separator appears at the **start or the middle**, never when
 * it is only the trailing directory marker. Deciding that from the raw pattern instead made
 * every `foo/` rule root-only, which is how six of the shipped defaults came to apply at
 * depth zero and nowhere else (#201). The distinction has to be drawn after the trailing
 * slash is removed, so the check below reads `normalized` rather than `pattern`.
 */
/**
 * The forms of a pattern that name a **directory**, as opposed to its contents.
 *
 * `drafts/**` is excluded here on purpose: in gitignore it says "everything under drafts",
 * not "drafts". Keeping that distinction is what lets a negation reach inside.
 */
function directoryForms(pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, '/');
  if (normalized.endsWith('/**')) return [];
  return expand(normalized).filter((form) => !form.endsWith('/**'));
}

function expand(pattern: string): string[] {
  let normalized = pattern.replace(/\\/g, '/');
  const directoryOnly = normalized.endsWith('/');
  if (directoryOnly) normalized = normalized.slice(0, -1);
  const rooted = normalized.startsWith('/');
  if (rooted) normalized = normalized.slice(1);

  const anchored = rooted || (normalized.includes('/') && !normalized.startsWith('**/'));
  const forms = anchored ? [normalized] : [normalized, `**/${normalized}`];
  // A directory pattern also excludes everything beneath it.
  return forms.flatMap((form) => [form, `${form}/**`]);
}

export function createMatcher(rules: readonly IgnoreRule[]): Matcher {
  const compiled = rules.map((rule) => ({
    rule,
    isMatch: picomatch(expand(rule.pattern), { dot: true }),
    // A second matcher that answers "does this rule exclude the directory *itself*", which
    // is a different question from "does it exclude things inside it" and the reason
    // pruning needs its own form. See `decideDirectory`.
    matchesDirectory: picomatch(directoryForms(rule.pattern), { dot: true }),
  }));

  function decide(canonicalPath: string): IgnoreRule | null {
    let deciding: IgnoreRule | null = null;
    // Last matching rule wins, which is what makes `!pattern` able to re-include. The
    // deciding rule is the last one that matched at all, and it excludes only when it was
    // not a negation.
    for (const { rule, isMatch } of compiled) {
      if (isMatch(canonicalPath)) deciding = rule.negated ? null : rule;
    }
    return deciding;
  }

  /**
   * Whether a whole directory can be skipped without descending into it.
   *
   * Git's rule, deliberately: a pattern excludes a directory only when it names the directory
   * (`node_modules`, `node_modules/`), not when it names the directory's *contents*
   * (`drafts/**`). The two are different statements and gitignore treats them differently, so
   * following git keeps a negation like `!drafts/keep.md` working under `drafts/**`, which is
   * behaviour Lorepack already had and a test already asserted.
   *
   * The cost of the other choice, pruning on any match, would be exactly that: `drafts/**`
   * would prune `drafts` and the negation would never get a chance. Choosing git's semantics
   * means the matching layer and the walking layer agree, which is what #209 asked for.
   *
   * Where a directory *is* named, git also says a negation cannot reach inside it, and that
   * holds here for the same reason: the walk never goes in. Anything below an excluded
   * directory is unreachable, and `lore inspect exclusions` reports the directory once
   * rather than each of its files.
   */
  function decideDirectory(canonicalPath: string): IgnoreRule | null {
    let deciding: IgnoreRule | null = null;
    for (const { rule, matchesDirectory } of compiled) {
      if (matchesDirectory(canonicalPath)) deciding = rule.negated ? null : rule;
    }
    return deciding;
  }

  return {
    rules,
    decide,
    decideDirectory,
    excludes(canonicalPath: string): boolean {
      return decide(canonicalPath) !== null;
    },
  };
}
