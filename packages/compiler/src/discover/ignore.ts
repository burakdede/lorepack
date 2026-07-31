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
 */
function expand(pattern: string): string[] {
  let normalized = pattern.replace(/\\/g, '/');
  const directoryOnly = normalized.endsWith('/');
  if (directoryOnly) normalized = normalized.slice(0, -1);
  if (normalized.startsWith('/')) normalized = normalized.slice(1);

  const anchored = pattern.includes('/') && !pattern.startsWith('**/');
  const forms = anchored ? [normalized] : [normalized, `**/${normalized}`];
  // A directory pattern also excludes everything beneath it.
  return forms.flatMap((form) => [form, `${form}/**`]);
}

export function createMatcher(rules: readonly IgnoreRule[]): Matcher {
  const compiled = rules.map((rule) => ({
    rule,
    isMatch: picomatch(expand(rule.pattern), { dot: true }),
  }));

  return {
    rules,
    excludes(canonicalPath: string): boolean {
      let excluded = false;
      // Last matching rule wins, which is what makes `!pattern` able to re-include.
      for (const { rule, isMatch } of compiled) {
        if (isMatch(canonicalPath)) excluded = !rule.negated;
      }
      return excluded;
    },
  };
}
