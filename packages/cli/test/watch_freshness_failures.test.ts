import { EventEmitter } from 'node:events';
import { renameSync, statSync } from 'node:fs';
import { LoreError, loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import type { ChokidarOptions } from 'chokidar';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { readActiveBuild } from '../src/services/project.js';
import { degradedFreshness, readFreshness, readStatus } from '../src/services/status.js';
import { resolveRealPath, startWatching } from '../src/services/watch.js';

const race = vi.hoisted(() => ({
  armed: false,
  failures: 0,
  unexpected: null as Error | null,
  watch: vi.fn<(path: string, options: ChokidarOptions) => EventEmitter>(),
}));

vi.mock('chokidar', () => ({ watch: race.watch }));
vi.mock('@lorepack/compiler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lorepack/compiler')>();
  return {
    ...actual,
    fingerprintSources: async (options: Parameters<typeof actual.fingerprintSources>[0]) => {
      if (race.unexpected !== null) {
        const error = race.unexpected;
        race.unexpected = null;
        throw error;
      }
      const artifact = options.artifacts.find((entry) => entry.relativePath === 'b.md');
      if (!race.armed || artifact === undefined) return actual.fingerprintSources(options);
      race.armed = false;
      race.failures += 1;
      const hidden = `${artifact.absolutePath}.temporarily-unavailable`;
      renameSync(artifact.absolutePath, hidden);
      try {
        return await actual.fingerprintSources(options);
      } finally {
        renameSync(hidden, artifact.absolutePath);
      }
    },
  };
});

const CONFIG = 'version: 1\nname: freshness-recovery\nsources: [.]\n';
const CORPUS = { 'lore.yaml': CONFIG, 'b.md': '# B\n\nOriginal source.\n' };
const FAST = { debounceMs: 40, stabilityMs: 40, pollMs: 10, reconcileIntervalMs: 120 };

beforeEach(() => {
  race.armed = false;
  race.failures = 0;
  race.unexpected = null;
  race.watch.mockReset();
  race.watch.mockImplementation(() => {
    const events = Object.assign(new EventEmitter(), {
      close: async () => {},
      getWatched: () => ({}),
    });
    queueMicrotask(() => events.emit('ready'));
    return events;
  });
});

async function settled(until: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!until() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('source read-open races, issue586', () => {
  it('reports unknown freshness after a real artifact disappears between discovery and open', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      const first = await runBuild({ config, progress: new ProgressBus() });
      const before = statSync(project.path('b.md'));
      race.armed = true;
      await expect(readFreshness({ config })).resolves.toEqual({
        sourceState: 'unknown',
        reason: 'b.md could not be read.',
      });
      expect(race.failures).toBe(1);
      const after = statSync(project.path('b.md'));
      expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
      expect(readActiveBuild(project.path('.lore'))?.buildId).toBe(first.buildId);
    });
  });

  it('keeps a post-ready scan failure from poisoning later event-free reconciliation', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      const first = await runBuild({ config, progress: new ProgressBus() });
      const warnings: { message: string; state: string; buildId: string | undefined }[] = [];
      const watching = startWatching({
        config,
        ...FAST,
        warn: (message) =>
          warnings.push({
            message,
            state: watching.status().state,
            buildId: readActiveBuild(project.path('.lore'))?.buildId,
          }),
        rebuild: () => runBuild({ config, progress: new ProgressBus() }),
      });
      try {
        await watching.ready;
        project.write('b.md', '# B\n\nUpdated stable walrus content.\n');
        const before = statSync(project.path('b.md'));
        race.armed = true;
        const events = race.watch.mock.results.at(-1)?.value;
        if (events === undefined) throw new Error('Expected the actual watcher event source.');
        events.emit('change', resolveRealPath(project.path('b.md')));
        await settled(() => warnings.some((entry) => entry.message.includes('b.md')));
        const warning = warnings.find((entry) => entry.message.includes('b.md'));
        expect(race.failures).toBe(1);
        expect(warning).toEqual(
          expect.objectContaining({ state: 'unknown', buildId: first.buildId }),
        );
        const after = statSync(project.path('b.md'));
        expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
        await settled(() => watching.rebuilds === 1);
        expect(watching.rebuilds, JSON.stringify(warnings)).toBe(1);
        expect(await watching.freshness()).toBe('clean');
        expect(readActiveBuild(project.path('.lore'))?.buildId).not.toBe(first.buildId);
      } finally {
        await watching.close();
      }
    });
  });

  it('recovers a directory-source floor read failure without filesystem events', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: directory-recovery\nsources: [docs]\n',
          '.loreignore': '/docs/ignored/\n',
          'docs/b.md': '# B\n\nOriginal source.\n',
          'docs/ignored/private.md': '# Hidden\n\nExcluded source.\n',
        },
      },
      async (project) => {
        const config = loadConfig({ cwd: project.root });
        const first = await runBuild({ config, progress: new ProgressBus() });
        const warnings: { message: string; state: string; buildId: string | undefined }[] = [];
        const watching = startWatching({
          config,
          ...FAST,
          warn: (message) =>
            warnings.push({
              message,
              state: watching.status().state,
              buildId: readActiveBuild(project.path('.lore'))?.buildId,
            }),
          rebuild: () => runBuild({ config, progress: new ProgressBus() }),
        });
        try {
          await watching.ready;
          await new Promise((resolve) => setTimeout(resolve, FAST.reconcileIntervalMs * 2));
          project.write('docs/b.md', '# B\n\nChanged directory-source walrus content.\n');
          project.write('docs/ignored/private.md', '# Hidden\n\nChanged excluded bytes.\n');
          const before = statSync(project.path('docs/b.md'));
          race.armed = true;
          await settled(() => warnings.some((entry) => entry.message.includes('b.md')));
          expect(race.failures).toBe(1);
          expect(warnings).toContainEqual(
            expect.objectContaining({ state: 'unknown', buildId: first.buildId }),
          );
          const after = statSync(project.path('docs/b.md'));
          expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
          await settled(() => watching.rebuilds === 1);
          expect(watching.rebuilds, JSON.stringify(warnings)).toBe(1);
          expect(watching.status().lastEventAt).toBeNull();
          expect(await watching.freshness()).toBe('clean');
          expect(readActiveBuild(project.path('.lore'))?.buildId).not.toBe(first.buildId);
        } finally {
          await watching.close();
        }
      },
    );
  }, 60_000);

  it('settles startup readiness after a failed source scan and recovers unchanged metadata', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      const first = await runBuild({ config, progress: new ProgressBus() });
      const warnings: string[] = [];
      race.armed = true;
      const watching = startWatching({
        config,
        ...FAST,
        warn: (message) => warnings.push(message),
        rebuild: () => runBuild({ config, progress: new ProgressBus() }),
      });
      try {
        let deadline: NodeJS.Timeout | undefined;
        const ready = await Promise.race([
          watching.ready.then(() => true),
          new Promise<false>((resolve) => {
            deadline = setTimeout(() => resolve(false), 8000);
          }),
        ]).finally(() => clearTimeout(deadline));
        expect(ready, warnings.join('')).toBe(true);
        expect(race.failures).toBe(1);
        expect(warnings.join('')).toContain('b.md');
        expect(watching.status().state).toBe('unknown');
        await settled(() => watching.status().state === 'clean');
        expect(watching.status().state).toBe('clean');
        expect(watching.status().lastEventAt).toBeNull();
        expect(watching.rebuilds).toBe(0);
        expect(readActiveBuild(project.path('.lore'))?.buildId).toBe(first.buildId);
      } finally {
        await watching.close();
      }
    });
  });

  it('keeps strict status errors while read-only freshness degrades the same read-open race', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      const first = await runBuild({ config, progress: new ProgressBus() });
      race.armed = true;
      await expect(readStatus({ config })).rejects.toMatchObject({
        code: 'LORE_E_SOURCE_UNREADABLE',
      });
      expect(race.failures).toBe(1);
      expect(readActiveBuild(project.path('.lore'))?.buildId).toBe(first.buildId);
      race.unexpected = new Error('Unexpected scan failure.');
      await expect(readFreshness({ config })).rejects.toThrow('Unexpected scan failure.');
    });
  });

  it('reports unexpected queue failures without swallowing them in read-only freshness', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      const first = await runBuild({ config, progress: new ProgressBus() });
      const warnings: string[] = [];
      const watching = startWatching({
        config,
        ...FAST,
        warn: (message) => warnings.push(message),
        rebuild: () => runBuild({ config, progress: new ProgressBus() }),
      });
      try {
        await watching.ready;
        project.write('b.md', '# B\n\nChanged after a transient scanner failure.\n');
        race.unexpected = new Error('Unexpected scan failure.');
        const events = race.watch.mock.results.at(-1)?.value;
        if (events === undefined) throw new Error('Expected the actual watcher event source.');
        events.emit('change', resolveRealPath(project.path('b.md')));
        await settled(() =>
          warnings.some((message) => message.includes('Unexpected scan failure.')),
        );
        expect(warnings.join('')).toContain('Unexpected scan failure.');
        await settled(() => watching.rebuilds === 1);
        expect(watching.rebuilds).toBe(1);
        expect(await watching.freshness()).toBe('clean');
        expect(readActiveBuild(project.path('.lore'))?.buildId).not.toBe(first.buildId);
      } finally {
        await watching.close();
      }
    });
  });

  it('keeps corrupt-build and unexpected errors outside the source-freshness allowlist', () => {
    expect(degradedFreshness(new LoreError('LORE_E_OBJECT_CORRUPT', 'Corrupt object.'))).toBeNull();
    expect(degradedFreshness(new Error('Unexpected failure.'))).toBeNull();
  });
});
