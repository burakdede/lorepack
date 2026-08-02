import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { createRevalidator } from '../src/services/revalidate.js';

/**
 * Freshness for a process that stays up.
 *
 * The two failures this sits between: checking once at startup, which reports `clean` for
 * an hour while the sources move, and checking properly per request, which content-hashes
 * the corpus to annotate an answer that took milliseconds.
 */

const CONFIG = 'version: 1\nname: revalidated\nsources:\n  - .\n';
const CORPUS = { 'lore.yaml': CONFIG, 'a.md': '# A\n\nFirst.\n', 'b.md': '# B\n\nSecond.\n' };

describe('within the interval', () => {
  it('answers from cache and touches nothing', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      let clock = 1000;
      const revalidator = createRevalidator({ config, intervalMs: 5000, now: () => clock });

      expect(await revalidator.freshness()).toBe('clean');
      expect(revalidator.deepChecks).toBe(1);

      clock += 100;
      for (let index = 0; index < 20; index += 1) await revalidator.freshness();

      // Not one extra check of any kind: this is the whole point of the interval.
      expect(revalidator.deepChecks).toBe(1);
      expect(revalidator.prescreens).toBe(1);
    });
  });
});

describe('past the interval', () => {
  it('prescreens, and stops there when nothing moved', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      let clock = 1000;
      const revalidator = createRevalidator({ config, intervalMs: 100, now: () => clock });
      await revalidator.freshness();

      clock += 5000;
      expect(await revalidator.freshness()).toBe('clean');

      // The cheap scan ran again; the hashing check did not, because nothing moved.
      expect(revalidator.prescreens).toBe(2);
      expect(revalidator.deepChecks).toBe(1);
    });
  });

  it('notices an edit made after the process started', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      let clock = 1000;
      const revalidator = createRevalidator({ config, intervalMs: 100, now: () => clock });
      expect(await revalidator.freshness()).toBe('clean');

      writeFileSync(join(project.root, 'c.md'), '# C\n\nAdded while serving.\n', 'utf8');
      clock += 5000;

      expect(await revalidator.freshness()).toBe('dirty');
      expect(revalidator.deepChecks).toBe(2);
    });
  });

  it('checks every request at an interval of zero', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      const revalidator = createRevalidator({ config, intervalMs: 0 });
      await revalidator.freshness();
      await revalidator.freshness();
      await revalidator.freshness();

      expect(revalidator.prescreens).toBe(3);
      // Still one deep check: the prescreen found nothing moved each time.
      expect(revalidator.deepChecks).toBe(1);
    });
  });
});

describe('frozen', () => {
  it('never looks at the sources at all', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      const revalidator = createRevalidator({ config, intervalMs: 0, frozen: true });
      expect(await revalidator.freshness()).toBe('unknown');
      expect(revalidator.prescreens).toBe(0);
      expect(revalidator.deepChecks).toBe(0);
    });
  });
});

describe('a source tree that cannot be walked', () => {
  it('degrades rather than failing the read', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      const revalidator = createRevalidator({
        // A project root that does not exist stands in for every way a scan can fail.
        config: { ...config, projectRoot: join(project.root, 'gone') },
        intervalMs: 0,
      });

      // No throw: a read of a sealed build is never failed by the source tree (#147).
      expect(['clean', 'dirty', 'unknown']).toContain(await revalidator.freshness());
    });
  });
});
