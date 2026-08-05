import { rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';

/**
 * A damaged build can be rebuilt (#251).
 *
 * Every case here was permanently unrecoverable: `lore build` reported "No changes" over a
 * build nobody could open, and the next read failed exactly as before. In two of them the
 * *build itself* crashed on the damaged predecessor, which is backwards: the command that
 * exists to produce a good build failed because a bad one existed.
 *
 * The assertion that matters is the **last** one in each case, that a read succeeds afterwards.
 * Asserting only that the first command produced a good error message would have passed the
 * whole time this was broken, which is exactly how it survived a phase.
 */

const CONFIG = 'version: 1\nname: damaged\nsources:\n  - .\n';
const RUNBOOK = '# Runbook\n\n## Rollback\n\nActivation is a pointer change.\n';

/** Damages the active build, then proves a rebuild puts the project back. */
async function recoversFrom(damage: (database: string, directory: string) => void): Promise<void> {
  await withTempProject({ files: { 'lore.yaml': CONFIG, 'runbook.md': RUNBOOK } }, async (temp) => {
    const config = () => loadConfig({ cwd: temp.root });
    const first = await runBuild({ config: config(), progress: new ProgressBus() });

    const directory = join(temp.root, '.lore', 'builds', first.buildId);
    damage(join(directory, 'context.sqlite'), directory);

    // Reading is expected to fail, and to fail in the taxonomy's terms rather than with a
    // raw SQLite string. Which code depends on the damage; that it is typed does not.
    const broken = createLocalRuntimeBackend({ projectRoot: temp.root });
    const failure = await createRuntime(broken)
      .search({ query: 'rollback', limit: 5, includeArchived: false, debug: false })
      .catch((error: unknown) => error);
    broken.close();
    expect((failure as { code?: string }).code).toMatch(/^LORE_E_/);
    expect((failure as { code?: string }).code).not.toBe('LORE_E_INTERNAL');

    // The rebuild, which is what the remediation tells a reader to run.
    const again = await runBuild({ config: config(), progress: new ProgressBus() });
    expect(again.buildId).toBe(first.buildId);

    // And the assertion the whole test exists for.
    const fixed = createLocalRuntimeBackend({ projectRoot: temp.root });
    try {
      const result = await createRuntime(fixed).search({
        query: 'rollback',
        limit: 5,
        includeArchived: false,
        debug: false,
      });
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits[0]?.locator.relativePath).toBe('runbook.md');
    } finally {
      fixed.close();
    }
  });
}

describe('a build damaged on disk', () => {
  it('recovers when the database was deleted', async () => {
    await recoversFrom((database) => rmSync(database));
  });

  it('recovers when the database was truncated', async () => {
    await recoversFrom((database) => truncateSync(database, 0));
  });

  it('recovers when the database was overwritten with something else', async () => {
    await recoversFrom((database) => writeFileSync(database, 'not a database at all'));
  });

  it('recovers when the whole build directory is gone', async () => {
    await recoversFrom((_database, directory) =>
      rmSync(directory, { recursive: true, force: true }),
    );
  });

  /**
   * The one whose remediation Lorepack wrote itself.
   *
   * #235's guard refuses a build at an older catalog schema and tells the reader to run
   * `lore build`. Until #251 that command declined to help, so the product named an action
   * that did nothing about a problem it had just diagnosed.
   */
  it('recovers when the build is at an older catalog schema', async () => {
    await recoversFrom((database) => {
      const writable = new DatabaseSync(database);
      writable.exec(
        'DELETE FROM schema_migrations WHERE id = (SELECT max(id) FROM schema_migrations)',
      );
      writable.close();
    });
  });
});

describe('an intact build is still reused', () => {
  /**
   * The other half, and the reason this cannot be fixed by rebuilding unconditionally.
   *
   * Reuse is what makes a no-op rebuild fast. A fix that replaced every build every time would
   * pass every test above and make the product worse.
   */
  it('reports no changes and writes nothing new', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'runbook.md': RUNBOOK } },
      async (temp) => {
        const config = () => loadConfig({ cwd: temp.root });
        const first = await runBuild({ config: config(), progress: new ProgressBus() });
        const again = await runBuild({ config: config(), progress: new ProgressBus() });

        expect(again.buildId).toBe(first.buildId);
        expect(again.created).toBe(false);
      },
    );
  });
});
