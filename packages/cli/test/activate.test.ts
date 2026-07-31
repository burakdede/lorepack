import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { readActiveBuild } from '../src/services/project.js';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

async function project<T>(
  files: Record<string, string>,
  body: (root: string, lore: (args: string[]) => ReturnType<typeof run>) => Promise<T>,
): Promise<T> {
  return withTempProject({ files: { 'lore.yaml': CONFIG, ...files } }, async (temp) =>
    body(temp.root, (args) => run(['--cwd', temp.root, ...args])),
  );
}

function build(root: string) {
  return runBuild({ config: loadConfig({ cwd: root }), progress: new ProgressBus() });
}

/** Three builds, oldest first. Each edit produces a distinct content-derived id. */
async function threeBuilds(
  root: string,
): Promise<{ first: string; second: string; third: string }> {
  const first = await build(root);
  writeFileSync(join(root, 'a.md'), '# A\n\nSecond text.', 'utf8');
  const second = await build(root);
  writeFileSync(join(root, 'a.md'), '# A\n\nThird text.', 'utf8');
  const third = await build(root);
  return { first: first.buildId, second: second.buildId, third: third.buildId };
}

function active(root: string): string | null {
  return readActiveBuild(join(root, '.lore'))?.buildId ?? null;
}

describe('lore builds', () => {
  it('lists history newest first with an active marker and counts', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { third } = await threeBuilds(root);
      const result = await lore(['builds']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('* active');
      const lines = result.stdout.split('\n').filter((line) => line.includes('lore_'));
      expect(lines).toHaveLength(3);
      expect(lines[0]?.startsWith('*')).toBe(true);
      expect(lines[0]).toContain(third.slice(0, 17));
    });
  });

  it('reports history as JSON', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { third } = await threeBuilds(root);
      const parsed = JSON.parse((await lore(['--json', 'builds'])).stdout);
      expect(parsed.activeBuildId).toBe(third);
      expect(parsed.builds).toHaveLength(3);
      expect(parsed.builds[0].counts.chunks).toBeGreaterThan(0);
    });
  });

  it('fails with an actionable message in a project that has no builds', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (_root, lore) => {
      const result = await lore(['builds']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('lore build');
    });
  });
});

describe('lore activate', () => {
  it('accepts a full id and moves the pointer', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first, third } = await threeBuilds(root);
      expect(active(root)).toBe(third);

      const result = await lore(['activate', first]);
      expect(result.code).toBe(0);
      expect(active(root)).toBe(first);
    });
  });

  it('accepts an unambiguous prefix', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first } = await threeBuilds(root);
      const result = await lore(['activate', first.slice(0, 15)]);
      expect(result.code).toBe(0);
      expect(active(root)).toBe(first);
    });
  });

  it('refuses an ambiguous prefix and lists the candidates', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first, second } = await threeBuilds(root);
      const before = active(root);

      // "lore_" alone matches every build.
      const result = await lore(['activate', 'lore_']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('matches 3 builds');
      expect(result.stderr).toContain(first);
      expect(result.stderr).toContain(second);
      expect(active(root)).toBe(before);
    });
  });

  it('leaves the pointer alone when the build is unknown', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { third } = await threeBuilds(root);
      const result = await lore(['activate', 'lore_ffffffff']);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('LORE_E_BUILD_NOT_FOUND');
      expect(active(root)).toBe(third);
    });
  });

  it('fails pre-flight on a corrupt build without touching the pointer', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first, third } = await threeBuilds(root);
      writeFileSync(join(root, '.lore', 'builds', first, 'context.sqlite'), 'not a database');

      const result = await lore(['activate', first]);
      expect(result.code).not.toBe(0);
      expect(active(root)).toBe(third);
    });
  });

  it('fails when the build is recorded but its files are gone', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first, third } = await threeBuilds(root);
      rmSync(join(root, '.lore', 'builds', first), { recursive: true, force: true });

      const result = await lore(['activate', first]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('files are missing');
      expect(active(root)).toBe(third);
    });
  });

  it('says so and changes nothing when the build is already active', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { third } = await threeBuilds(root);
      const before = JSON.parse((await lore(['--json', 'activate', third])).stdout);
      expect(before.changed).toBe(false);
    });
  });
});

describe('lore rollback', () => {
  it('returns to the previous verified build with no argument', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { second, third } = await threeBuilds(root);
      expect(active(root)).toBe(third);

      const result = await lore(['rollback']);
      expect(result.code).toBe(0);
      expect(active(root)).toBe(second);
    });
  });

  it('activates a named build when given one', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first } = await threeBuilds(root);
      await lore(['rollback', first]);
      expect(active(root)).toBe(first);
    });
  });

  it('performs no parsing, proven by deleting every source first', async () => {
    // Section 18.7: rollback never recompiles. If it did, it would fail exactly when it is
    // needed most, which is when the sources that produced the old build are gone.
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { second } = await threeBuilds(root);
      rmSync(join(root, 'a.md'));

      const started = performance.now();
      const result = await lore(['rollback']);
      const elapsed = performance.now() - started;

      expect(result.code).toBe(0);
      expect(active(root)).toBe(second);
      expect(elapsed).toBeLessThan(1000);
    });
  });

  it('increases the generation monotonically across activate, rollback and activate', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first, third } = await threeBuilds(root);

      const one = JSON.parse((await lore(['--json', 'activate', first])).stdout);
      const two = JSON.parse((await lore(['--json', 'rollback', third])).stdout);
      const three = JSON.parse((await lore(['--json', 'activate', first])).stdout);

      expect(two.generation).toBeGreaterThan(one.generation);
      expect(three.generation).toBeGreaterThan(two.generation);
    });
  });

  it('says there is nothing to return to when only one build exists', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await build(root);
      const result = await lore(['rollback']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('no earlier verified build');
    });
  });
});

describe('lore prune', () => {
  async function manyBuilds(root: string, count: number) {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      writeFileSync(join(root, 'a.md'), `# A\n\nRevision ${index}.`, 'utf8');
      ids.push((await build(root)).buildId);
    }
    return ids;
  }

  it('prints a plan and removes nothing without --yes', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const ids = await manyBuilds(root, 8);
      const result = await lore(['prune']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Nothing was removed');
      expect(readdirSync(join(root, '.lore', 'builds'))).toHaveLength(ids.length);
    });
  });

  it('keeps the active build and the previous five', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const ids = await manyBuilds(root, 8);
      const result = await lore(['prune', '--yes']);

      expect(result.code).toBe(0);
      const remaining = readdirSync(join(root, '.lore', 'builds')).sort();
      expect(remaining).toHaveLength(6);
      expect(remaining).toContain(ids.at(-1) ?? '');
      expect(remaining).not.toContain(ids[0]);
    });
  });

  it('never deletes an object a retained build still references', async () => {
    // Objects are content addressed and shared. Deleting one still in use would break the
    // very builds retention exists to protect.
    await project(
      { 'a.md': '# A\n\nText.', 'keep.md': '# Keep\n\nStable.' },
      async (root, lore) => {
        await manyBuilds(root, 8);
        await lore(['prune', '--yes']);

        const active = readActiveBuild(join(root, '.lore'));
        const objects = readdirSync(join(root, '.lore', 'objects', 'sha256'), { recursive: true });
        expect(objects.length).toBeGreaterThan(0);

        // The retained active build must still answer, which requires its objects.
        const status = JSON.parse((await lore(['--json', 'status'])).stdout);
        expect(status.activeBuildId).toBe(active?.buildId);
        expect(status.sourceState).toBe('clean');
      },
    );
  });

  it('respects an explicit --keep', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await manyBuilds(root, 8);
      await lore(['prune', '--keep', '1', '--yes']);
      expect(readdirSync(join(root, '.lore', 'builds'))).toHaveLength(2);
    });
  });

  it('rejects a nonsense --keep', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await build(root);
      const result = await lore(['prune', '--keep', 'lots', '--yes']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('whole number');
    });
  });

  it('leaves a project with few builds untouched', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await build(root);
      const result = await lore(['prune', '--yes']);
      expect(result.stdout).toContain('Nothing to remove');
      expect(existsSync(join(root, '.lore', 'builds'))).toBe(true);
    });
  });
});
