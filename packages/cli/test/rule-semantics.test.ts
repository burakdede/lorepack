import { loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { run } from './helpers.js';

/**
 * What declared rules *mean* once a build is being read, end to end through the real commands.
 *
 * The ranking math and the labels existed before this; what did not exist was a test that a
 * user's declaration actually changes what an agent receives. That is the whole claim of
 * section 4.5, and it spans four stages: config, resolution, catalog, ranking. A unit test of
 * any one of them can pass while the promise is broken.
 *
 * The other half of the claim is what Lorepack must never say, and that is enforced
 * repository-wide by `pnpm check:no-conflict-claims` rather than here, because a copy rule that
 * only covers the strings a test happens to exercise is not a rule.
 */

const CONFIG = `version: 1
name: labels
sources:
  - .
rules:
  - match: "docs/runbook-v2.md"
    authority: 90
    supersedes: ["docs/runbook-v1.md"]
  - match: "draft.md"
    status: draft
  - match: "archived.md"
    status: archived
`;

const FILES = {
  'lore.yaml': CONFIG,
  'docs/runbook-v2.md': '# Runbook v2\n\nRollback the release by running lore rollback.\n',
  'docs/runbook-v1.md': '# Runbook v1\n\nRollback the release the old way.\n',
  'draft.md': '# Draft plan\n\nRollback ideas, half-formed.\n',
  'archived.md': '# Archive\n\nRollback notes from 2019.\n',
};

async function built<T>(
  body: (lore: (args: string[]) => ReturnType<typeof run>) => Promise<T>,
): Promise<T> {
  return withTempProject({ files: FILES }, async (temp) => {
    await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });
    return body((args) => run(['--cwd', temp.root, ...args]));
  });
}

interface Hit {
  readonly locator: { readonly relativePath: string };
  readonly labels?: readonly string[];
}

const paths = (hits: readonly Hit[]): string[] => hits.map((hit) => hit.locator.relativePath);

describe('a declaration changes what is returned', () => {
  it('keeps a superseded source out of default results while it stays readable', async () => {
    await built(async (lore) => {
      const search = JSON.parse((await lore(['--json', 'search', 'rollback'])).stdout) as {
        hits: Hit[];
      };
      expect(paths(search.hits)).toContain('docs/runbook-v2.md');
      // The superseded file matches the query just as well. It is absent because the user
      // said so, not because Lorepack judged it.
      expect(paths(search.hits)).not.toContain('docs/runbook-v1.md');

      // Still readable, which is the difference between superseded and excluded.
      const read = await lore(['inspect', 'docs/runbook-v1.md']);
      expect(read.code).toBe(0);
      expect(read.stdout).toContain('runbook-v1.md');
    });
  });

  it('ranks a higher declared authority above a lower one', async () => {
    await built(async (lore) => {
      const search = JSON.parse((await lore(['--json', 'search', 'rollback'])).stdout) as {
        hits: Hit[];
      };
      expect(search.hits[0]?.locator.relativePath).toBe('docs/runbook-v2.md');
    });
  });

  it('labels a draft everywhere it appears, in the human output and the JSON', async () => {
    await built(async (lore) => {
      const human = await lore(['search', 'rollback']);
      expect(human.stdout).toContain('[draft]');

      const search = JSON.parse((await lore(['--json', 'search', 'rollback'])).stdout) as {
        hits: Hit[];
      };
      const draft = search.hits.find((hit) => hit.locator.relativePath === 'draft.md');
      expect(draft?.labels).toContain('draft');
    });
  });

  /**
   * Archived is not deleted. It is out of the way until asked for, which is what makes the
   * status usable for a document someone still needs occasionally.
   */
  it('excludes an archived source by default and returns it when asked', async () => {
    await built(async (lore) => {
      const byDefault = JSON.parse((await lore(['--json', 'search', 'rollback'])).stdout) as {
        hits: Hit[];
      };
      expect(paths(byDefault.hits)).not.toContain('archived.md');

      const asked = JSON.parse(
        (await lore(['--json', 'search', 'rollback', '--include-archived'])).stdout,
      ) as { hits: Hit[] };
      expect(paths(asked.hits)).toContain('archived.md');
      expect(
        asked.hits.find((hit) => hit.locator.relativePath === 'archived.md')?.labels,
      ).toContain('archived');
    });
  });

  it('shows the rules that produced all of this, with authority named as a hint', async () => {
    await built(async (lore) => {
      const result = await lore(['inspect', 'rules']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('docs/runbook-v2.md');
      expect(result.stdout).toContain('draft');
      // The heading has to keep saying what authority is. A number in a column is exactly
      // where a reader starts believing it was measured rather than declared.
      expect(result.stdout).toMatch(/ranking hint you declared/);
    });
  });
});
