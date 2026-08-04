import { LoreError } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import { type RuleInput, resolveRules } from '../src/rules/resolve.js';

/**
 * Rule resolution, which is where a user's declaration becomes a fact about an artifact.
 *
 * The thing under test is precedence, not truth. Section 4.5 forbids Lorepack from deciding
 * which of two documents is correct, so every assertion here is about honouring what was
 * declared and refusing loudly what cannot be honoured. Nothing looks at content.
 */

const ARTIFACTS: RuleInput[] = [
  { artifactId: 'p:docs/current.md', relativePath: 'docs/current.md' },
  { artifactId: 'p:docs/old.md', relativePath: 'docs/old.md' },
  { artifactId: 'p:docs/older.md', relativePath: 'docs/older.md' },
  { artifactId: 'p:drafts/idea.md', relativePath: 'drafts/idea.md' },
];

type Rule = {
  match: string;
  status?: string;
  authority?: number;
  supersedes?: string[];
  replace?: boolean;
};

function resolve(
  rules: Rule[],
  strictRules = false,
  artifacts = ARTIFACTS,
): ReturnType<typeof resolveRules> {
  return resolveRules({ artifacts, config: { rules, strictRules } });
}

const forPath = (
  result: ReturnType<typeof resolveRules>,
  path: string,
): ReturnType<typeof resolveRules>['resolved'][number] => {
  const found = result.resolved.find((entry) => entry.relativePath === path);
  if (found === undefined) throw new Error(`no resolution for ${path}`);
  return found;
};

describe('what a rule declares', () => {
  it('leaves an artifact neutral when no rule matches it', () => {
    const result = resolve([{ match: 'drafts/**', status: 'draft' }]);
    expect(forPath(result, 'docs/current.md')).toMatchObject({
      status: 'active',
      authority: 50,
      supersedes: [],
      matchedRules: [],
    });
  });

  it('applies status and authority from a matching rule', () => {
    const result = resolve([{ match: 'drafts/**', status: 'draft', authority: 20 }]);
    expect(forPath(result, 'drafts/idea.md')).toMatchObject({ status: 'draft', authority: 20 });
  });

  /** Section 12.7: later rules win on scalars, which is how a list read top to bottom behaves. */
  it('lets a later rule override an earlier one, and records both as matched', () => {
    const result = resolve([
      { match: 'docs/**', authority: 60 },
      { match: 'docs/current.md', authority: 90 },
    ]);
    expect(forPath(result, 'docs/current.md')).toMatchObject({
      authority: 90,
      matchedRules: [0, 1],
    });
    expect(forPath(result, 'docs/old.md').authority).toBe(60);
  });

  it('resolves supersedes globs to artifact ids, sorted and deduplicated', () => {
    const result = resolve([{ match: 'docs/current.md', supersedes: ['docs/old*.md'] }]);
    expect(forPath(result, 'docs/current.md').supersedes).toEqual([
      'p:docs/old.md',
      'p:docs/older.md',
    ]);
  });

  /**
   * Merging is the default because two rules each naming something superseded mean both, and
   * dropping one silently is the quiet loss this project refuses everywhere else.
   */
  it('merges supersedes lists by default and replaces only when asked', () => {
    const merged = resolve([
      { match: 'docs/current.md', supersedes: ['docs/old.md'] },
      { match: 'docs/current.md', supersedes: ['docs/older.md'] },
    ]);
    expect(forPath(merged, 'docs/current.md').supersedes).toEqual([
      'p:docs/old.md',
      'p:docs/older.md',
    ]);

    const replaced = resolve([
      { match: 'docs/current.md', supersedes: ['docs/old.md'] },
      { match: 'docs/current.md', supersedes: ['docs/older.md'], replace: true },
    ]);
    expect(forPath(replaced, 'docs/current.md').supersedes).toEqual(['p:docs/older.md']);
  });

  /**
   * A broad glob on both sides is a normal thing to write. Without this, every document in
   * `docs/**` would supersede itself and the build would fail with a cycle of length one.
   */
  it('never lets an artifact supersede itself', () => {
    const result = resolve([{ match: 'docs/current.md', supersedes: ['docs/**'] }]);
    const current = forPath(result, 'docs/current.md');
    expect(current.supersedes).not.toContain('p:docs/current.md');
    expect(current.supersedes).toEqual(['p:docs/old.md', 'p:docs/older.md']);
  });

  /**
   * The same broad glob on both sides *is* a cycle, and a real one: three documents each
   * claiming to replace the other two. Self-exclusion prevents the meaningless loop of length
   * one; it does not paper over a genuine contradiction.
   */
  it('still refuses a broad glob that makes every file supersede every other', () => {
    expect(() => resolve([{ match: 'docs/**', supersedes: ['docs/**'] }])).toThrowError(
      /supersede each other in a loop/,
    );
  });
});

describe('what is refused, and how loudly', () => {
  it('refuses a status the rest of the system cannot store', () => {
    expect(() => resolve([{ match: 'docs/**', status: 'deprecated' }])).toThrowError(
      /has status "deprecated"/,
    );
  });

  it('refuses authority outside 0 to 100, naming the rule', () => {
    expect(() => resolve([{ match: 'docs/**', authority: 150 }])).toThrowError(/authority to 150/);
    expect(() => resolve([{ match: 'docs/**', authority: -1 }])).toThrowError(/docs/);
  });

  it('refuses a supersedes target the build does not contain', () => {
    expect(() =>
      resolve([{ match: 'docs/current.md', supersedes: ['docs/missing.md'] }]),
    ).toThrowError(/matches no file in this build/);
  });

  /**
   * Two documents each claiming to replace the other is not a state Lorepack can resolve, and
   * choosing one would be exactly the invented truth section 4.5 forbids.
   */
  it('refuses a supersession cycle and walks the whole loop in the message', () => {
    const error = (() => {
      try {
        resolve([
          { match: 'docs/current.md', supersedes: ['docs/old.md'] },
          { match: 'docs/old.md', supersedes: ['docs/older.md'] },
          { match: 'docs/older.md', supersedes: ['docs/current.md'] },
        ]);
        return null;
      } catch (caught) {
        return caught as LoreError;
      }
    })();

    expect(error).toBeInstanceOf(LoreError);
    expect(error?.message).toContain('docs/current.md');
    expect(error?.message).toContain('docs/old.md');
    expect(error?.message).toContain('docs/older.md');
    expect(error?.message).toContain('->');
  });

  it('warns about a rule that matched nothing, and fails on it under strictRules', () => {
    const lenient = resolve([{ match: 'nowhere/**', status: 'draft' }]);
    expect(lenient.warnings.map((warning) => warning.code)).toEqual(['rule-matched-nothing']);

    expect(() => resolve([{ match: 'nowhere/**', status: 'draft' }], true)).toThrowError(
      /matched no file/,
    );
  });
});

describe('the canonical form that feeds build identity', () => {
  it('changes when a rule changes what an artifact is', () => {
    const before = resolve([{ match: 'docs/**', authority: 60 }]).canonical;
    const after = resolve([{ match: 'docs/**', authority: 61 }]).canonical;
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });

  /**
   * The other half, and the one that is easy to get wrong: a user tidying their configuration
   * without changing its effect should not rebuild the world. Identity is what a build
   * *contains*, not how the instructions that produced it were written.
   */
  it('does not change when rules are rewritten to the same effect', () => {
    const one = resolve([
      { match: 'docs/**', authority: 60 },
      { match: 'drafts/**', status: 'draft' },
    ]).canonical;
    const two = resolve([
      { match: 'drafts/**', status: 'draft' },
      { match: 'docs/*.md', authority: 60 },
      { match: 'docs/**', authority: 60 },
    ]).canonical;
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it('is empty when nothing was declared, so a project without rules is unaffected', () => {
    expect(resolve([]).canonical).toEqual([]);
  });

  it('does not depend on the order artifacts were discovered in', () => {
    const rules: Rule[] = [{ match: 'docs/**', authority: 70 }];
    const forward = resolve(rules).canonical;
    const reversed = resolve(rules, false, [...ARTIFACTS].reverse()).canonical;
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});
