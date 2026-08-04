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

  return {
    rules,
    decide,
    excludes(canonicalPath: string): boolean {
      return decide(canonicalPath) !== null;
    },
  };
}
