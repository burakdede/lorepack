import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BuildId, LoreError } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import {
  createCandidateDirectory,
  discardCandidateDirectory,
  sealCandidateDirectory,
  writeFileAtomic,
} from '../src/atomic.js';
import { ProjectLock } from '../src/lock.js';
import { FileObjectStore } from '../src/object-store.js';
import { openWritable } from '../src/sqlite.js';
import { LocalActiveBuildProvider, LocalStateStore } from '../src/state-store.js';

const MIGRATIONS = join(import.meta.dirname, '..', '..', '..', 'migrations', 'local');

const buildId = (seed: string): BuildId => `lore_${seed.repeat(64).slice(0, 64)}` as BuildId;
const BUILD_A = buildId('a');
const BUILD_B = buildId('b');

function summary(id: BuildId, state = 'verified', createdAt = '2026-07-31T10:00:00Z') {
  return {
    buildId: id,
    state: state as 'verified',
    createdAt,
    counts: { artifacts: 1, nodes: 2, chunks: 3, tables: 0, tableRows: 0 },
  };
}

/** A sealed build needs a real context.sqlite for the provider to open. */
function materializeBuild(buildsDirectory: string, id: BuildId): void {
  const directory = join(buildsDirectory, id);
  mkdirSync(directory, { recursive: true });
  const db = openWritable(join(directory, 'context.sqlite'));
  db.exec('CREATE TABLE chunks (id TEXT PRIMARY KEY) STRICT');
  db.prepare('INSERT INTO chunks (id) VALUES (?)').run(id);
  db.close();
}

describe('atomic writes', () => {
  it('leaves no temporary file behind on success', async () => {
    await withTempProject({}, (project) => {
      writeFileAtomic(project.path('out/manifest.json'), '{"a":1}');
      expect(readFileSync(project.path('out/manifest.json'), 'utf8')).toBe('{"a":1}');
      expect(readdirSync(project.path('out')).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
    });
  });

  it('reports a typed error and cleans up when the path is unwritable', async () => {
    await withTempProject({}, (project) => {
      // A directory where a file is expected: the write must fail, not half-succeed.
      mkdirSync(project.path('blocked'), { recursive: true });
      try {
        writeFileAtomic(project.path('blocked'), 'x');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as LoreError).code).toBe('LORE_E_INTERNAL');
      }
      expect(readdirSync(project.root).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
    });
  });
});

describe('candidate build directories', () => {
  it('seals a candidate into its final home atomically', async () => {
    await withTempProject({}, (project) => {
      const lore = project.path('.lore');
      const candidate = createCandidateDirectory(lore);
      writeFileSync(join(candidate.path, 'manifest.json'), '{}', 'utf8');

      const destination = join(lore, 'builds', BUILD_A);
      expect(sealCandidateDirectory(candidate, destination).sealed).toBe(true);
      expect(existsSync(join(destination, 'manifest.json'))).toBe(true);
      expect(existsSync(candidate.path)).toBe(false);
    });
  });

  it('keeps candidates outside builds/ so an interrupted build is never mistaken for one', async () => {
    await withTempProject({}, (project) => {
      const lore = project.path('.lore');
      const candidate = createCandidateDirectory(lore);
      writeFileSync(join(candidate.path, 'partial.json'), '{}', 'utf8');
      expect(candidate.path.includes(join('.lore', 'tmp'))).toBe(true);
      expect(existsSync(join(lore, 'builds'))).toBe(false);
    });
  });

  it('discards a candidate completely', async () => {
    await withTempProject({}, (project) => {
      const candidate = createCandidateDirectory(project.path('.lore'));
      writeFileSync(join(candidate.path, 'x'), 'x', 'utf8');
      discardCandidateDirectory(candidate);
      expect(existsSync(candidate.path)).toBe(false);
    });
  });

  it('treats sealing an existing build id as a no-op, since ids are content derived', async () => {
    await withTempProject({}, (project) => {
      const lore = project.path('.lore');
      const destination = join(lore, 'builds', BUILD_A);

      const first = createCandidateDirectory(lore);
      writeFileSync(join(first.path, 'manifest.json'), '{"n":1}', 'utf8');
      sealCandidateDirectory(first, destination);

      const second = createCandidateDirectory(lore);
      writeFileSync(join(second.path, 'manifest.json'), '{"n":2}', 'utf8');
      expect(sealCandidateDirectory(second, destination).sealed).toBe(false);

      // The original is untouched and the duplicate candidate is gone.
      expect(readFileSync(join(destination, 'manifest.json'), 'utf8')).toBe('{"n":1}');
      expect(existsSync(second.path)).toBe(false);
    });
  });
});

describe('FileObjectStore', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('round-trips content and returns its hash', async () => {
    await withTempProject({}, async (project) => {
      const store = new FileObjectStore(project.path('objects'));
      const hash = await store.put(bytes('hello world'));
      expect(hash).toHaveLength(64);
      expect(new TextDecoder().decode((await store.get(hash)) ?? new Uint8Array())).toBe(
        'hello world',
      );
      expect(await store.has(hash)).toBe(true);
    });
  });

  it('returns null for an unknown hash rather than throwing', async () => {
    await withTempProject({}, async (project) => {
      const store = new FileObjectStore(project.path('objects'));
      expect(await store.get('f'.repeat(64))).toBeNull();
      expect(await store.has('f'.repeat(64))).toBe(false);
    });
  });

  it('deduplicates identical content without rewriting', async () => {
    await withTempProject({}, async (project) => {
      const store = new FileObjectStore(project.path('objects'));
      const first = await store.put(bytes('same'));
      const second = await store.put(bytes('same'));
      expect(second).toBe(first);
      const fanout = join(project.path('objects'), 'sha256', first.slice(0, 2), first.slice(2, 4));
      expect(readdirSync(fanout)).toHaveLength(1);
    });
  });

  it('uses two levels of fan-out so no directory grows unmanageable', async () => {
    await withTempProject({}, async (project) => {
      const store = new FileObjectStore(project.path('objects'));
      const hash = await store.put(bytes('fanout'));
      const expected = join(
        project.path('objects'),
        'sha256',
        hash.slice(0, 2),
        hash.slice(2, 4),
        hash.slice(4),
      );
      expect(existsSync(expected)).toBe(true);
    });
  });

  it('detects corruption on read and names the hash', async () => {
    await withTempProject({}, async (project) => {
      const store = new FileObjectStore(project.path('objects'));
      const hash = await store.put(bytes('original'));
      const path = join(
        project.path('objects'),
        'sha256',
        hash.slice(0, 2),
        hash.slice(2, 4),
        hash.slice(4),
      );
      writeFileSync(path, 'tampered', 'utf8');

      try {
        await store.get(hash);
        expect.unreachable('should have thrown');
      } catch (error) {
        const loreError = error as LoreError;
        expect(loreError.code).toBe('LORE_E_OBJECT_CORRUPT');
        expect(loreError.subject).toBe(hash);
        expect(loreError.remediation).toContain('.lore/cache');
      }
    });
  });

  it('quarantines a corrupt object so the next build regenerates it', async () => {
    await withTempProject({}, async (project) => {
      const store = new FileObjectStore(project.path('objects'));
      const hash = await store.put(bytes('x'));
      const path = join(
        project.path('objects'),
        'sha256',
        hash.slice(0, 2),
        hash.slice(2, 4),
        hash.slice(4),
      );
      writeFileSync(path, 'bad', 'utf8');
      store.quarantine(hash);
      expect(await store.get(hash)).toBeNull();
    });
  });
});

describe('LocalStateStore', () => {
  async function withState(run: (state: LocalStateStore, lore: string) => void): Promise<void> {
    await withTempProject({}, (project) => {
      const lore = project.path('.lore');
      const state = LocalStateStore.open(lore, MIGRATIONS);
      try {
        run(state, lore);
      } finally {
        state.close();
      }
    });
  }

  it('starts with no active build', async () => {
    await withState((state) => {
      expect(state.current()).toBeNull();
      expect(state.currentGeneration()).toBe(0);
    });
  });

  it('activates a verified build and increments the generation', async () => {
    await withState((state) => {
      state.recordBuild(summary(BUILD_A));
      const generation = state.activate(BUILD_A);
      expect(generation).toBe(1);
      expect(state.current()).toEqual({ buildId: BUILD_A, generation: 1 });
    });
  });

  it('refuses to activate a build that is not verified', async () => {
    await withState((state) => {
      state.recordBuild(summary(BUILD_A, 'failed'));
      try {
        state.activate(BUILD_A);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as LoreError).code).toBe('LORE_E_BUILD_VALIDATION');
        expect((error as LoreError).message).toContain('only a verified build');
      }
      expect(state.current()).toBeNull();
    });
  });

  it('refuses to activate an unknown build', async () => {
    await withState((state) => {
      expect(() => state.activate(BUILD_B)).toThrowError(LoreError);
    });
  });

  it('increases the generation monotonically across rollback', async () => {
    await withState((state) => {
      state.recordBuild(summary(BUILD_A));
      state.recordBuild(summary(BUILD_B, 'verified', '2026-07-31T11:00:00Z'));
      expect(state.activate(BUILD_A)).toBe(1);
      expect(state.activate(BUILD_B)).toBe(2);
      // Rolling back to the earlier build still moves the generation forward.
      expect(state.activate(BUILD_A)).toBe(3);
      expect(state.current()).toEqual({ buildId: BUILD_A, generation: 3 });
    });
  });

  it('marks the previously active build verified again rather than leaving two active', async () => {
    await withState((state) => {
      state.recordBuild(summary(BUILD_A));
      state.recordBuild(summary(BUILD_B, 'verified', '2026-07-31T11:00:00Z'));
      state.activate(BUILD_A);
      state.activate(BUILD_B);
      expect(state.getBuild(BUILD_A)?.state).toBe('verified');
      expect(state.getBuild(BUILD_B)?.state).toBe('active');
      expect(state.listBuilds().filter((b) => b.state === 'active')).toHaveLength(1);
    });
  });

  it('survives reopening, so the pointer is durable', async () => {
    await withTempProject({}, (project) => {
      const lore = project.path('.lore');
      const first = LocalStateStore.open(lore, MIGRATIONS);
      first.recordBuild(summary(BUILD_A));
      first.activate(BUILD_A);
      first.close();

      const second = LocalStateStore.open(lore, MIGRATIONS);
      expect(second.current()).toEqual({ buildId: BUILD_A, generation: 1 });
      second.close();
    });
  });
});

describe('LocalActiveBuildProvider', () => {
  async function withProvider(
    run: (
      provider: LocalActiveBuildProvider,
      state: LocalStateStore,
      builds: string,
    ) => Promise<void>,
  ): Promise<void> {
    await withTempProject({}, async (project) => {
      const lore = project.path('.lore');
      const builds = join(lore, 'builds');
      const state = LocalStateStore.open(lore, MIGRATIONS);
      const provider = new LocalActiveBuildProvider(state, builds);
      try {
        await run(provider, state, builds);
      } finally {
        provider.closeAll();
        state.close();
      }
    });
  }

  it('fails with an actionable error when nothing is active', async () => {
    await withProvider(async (provider) => {
      try {
        await provider.acquire();
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as LoreError).code).toBe('LORE_E_BUILD_NOT_FOUND');
        expect((error as LoreError).remediation).toContain('lore build');
      }
    });
  });

  it('lets an in-flight request finish on its build while the next sees the new one', async () => {
    await withProvider(async (provider, state, builds) => {
      materializeBuild(builds, BUILD_A);
      materializeBuild(builds, BUILD_B);
      state.recordBuild(summary(BUILD_A));
      state.recordBuild(summary(BUILD_B, 'verified', '2026-07-31T11:00:00Z'));
      state.activate(BUILD_A);

      // A request begins against build A.
      const inFlight = await provider.acquire();
      expect(inFlight.buildId).toBe(BUILD_A);

      // Activation happens while it is still running.
      state.activate(BUILD_B);

      // The in-flight request still reads build A, from its captured handle.
      const rows = provider.database(inFlight).prepare('SELECT id FROM chunks').all() as Array<{
        id: string;
      }>;
      expect(rows[0]?.id).toBe(BUILD_A);

      // The next request observes the new generation and the new build.
      const next = await provider.acquire();
      expect(next.buildId).toBe(BUILD_B);
      expect(next.generation).toBeGreaterThan(inFlight.generation);

      // No response can mix builds: the two handles are distinct databases.
      expect(provider.database(next)).not.toBe(provider.database(inFlight));

      inFlight.release();
      next.release();
    });
  });

  it('closes a drained old build exactly once, after its last release', async () => {
    await withProvider(async (provider, state, builds) => {
      materializeBuild(builds, BUILD_A);
      materializeBuild(builds, BUILD_B);
      state.recordBuild(summary(BUILD_A));
      state.recordBuild(summary(BUILD_B, 'verified', '2026-07-31T11:00:00Z'));
      state.activate(BUILD_A);

      const first = await provider.acquire();
      const second = await provider.acquire();
      state.activate(BUILD_B);
      expect(provider.openBuildCount).toBe(1);

      first.release();
      // Still open: the second request has not finished with it.
      expect(provider.openBuildCount).toBe(1);
      expect(() => provider.database(second).prepare('SELECT id FROM chunks').get()).not.toThrow();

      second.release();
      expect(provider.openBuildCount).toBe(0);

      // Releasing twice is harmless.
      expect(() => second.release()).not.toThrow();
    });
  });

  it('shares one open database between concurrent readers of the same build', async () => {
    await withProvider(async (provider, state, builds) => {
      materializeBuild(builds, BUILD_A);
      state.recordBuild(summary(BUILD_A));
      state.activate(BUILD_A);

      const a = await provider.acquire();
      const b = await provider.acquire();
      expect(provider.database(a)).toBe(provider.database(b));
      expect(provider.openBuildCount).toBe(1);
      a.release();
      b.release();
    });
  });
});

describe('ProjectLock', () => {
  it('serializes two acquisitions', async () => {
    await withTempProject({}, async (project) => {
      const path = project.path('.lore/lock');
      const first = new ProjectLock(path, { waitMs: 50, pollIntervalMs: 5 });
      const second = new ProjectLock(path, { waitMs: 50, pollIntervalMs: 5 });

      await first.acquire();
      await expect(second.acquire()).rejects.toThrowError(LoreError);
      first.release();
      await expect(second.acquire()).resolves.toBeUndefined();
      second.release();
    });
  });

  it('names the holding process and how to recover', async () => {
    await withTempProject({}, async (project) => {
      const path = project.path('.lore/lock');
      const holder = new ProjectLock(path);
      await holder.acquire();
      const blocked = new ProjectLock(path, { waitMs: 10, pollIntervalMs: 5 });
      try {
        await blocked.acquire();
        expect.unreachable('should have thrown');
      } catch (error) {
        const loreError = error as LoreError;
        expect(loreError.code).toBe('LORE_E_LOCK_HELD');
        expect(loreError.message).toContain(String(process.pid));
        expect(loreError.remediation).toContain('.lore/lock');
      } finally {
        holder.release();
      }
    });
  });

  it('reclaims a lock whose owner is gone', async () => {
    await withTempProject({}, async (project) => {
      const path = project.path('.lore/lock');
      // Another process took the lock and then died.
      const dead = new ProjectLock(path, { ownerPid: 999_001, isProcessAlive: () => true });
      await dead.acquire();

      // A new process arrives and finds the owner is no longer running.
      const survivor = new ProjectLock(path, {
        waitMs: 200,
        pollIntervalMs: 5,
        isProcessAlive: () => false,
      });
      await expect(survivor.acquire()).resolves.toBeUndefined();
      expect(survivor.held).toBe(true);
      survivor.release();
    });
  });

  it('does not reclaim a lock whose owner is alive and recent', async () => {
    await withTempProject({}, async (project) => {
      const path = project.path('.lore/lock');
      const holder = new ProjectLock(path, { ownerPid: 999_002, isProcessAlive: () => true });
      await holder.acquire();
      const other = new ProjectLock(path, {
        waitMs: 20,
        pollIntervalMs: 5,
        isProcessAlive: () => true,
      });
      await expect(other.acquire()).rejects.toThrowError(/holds the project lock/);
      holder.release();
    });
  });

  it('reclaims a lock held far longer than the staleness window', async () => {
    await withTempProject({}, async (project) => {
      const path = project.path('.lore/lock');
      let clock = 1_000_000;
      const holder = new ProjectLock(path, {
        ownerPid: 999_003,
        now: () => clock,
        isProcessAlive: () => true,
      });
      await holder.acquire();

      clock += 10 * 60_000;
      const later = new ProjectLock(path, {
        now: () => clock,
        waitMs: 100,
        pollIntervalMs: 5,
        staleAfterMs: 5 * 60_000,
        isProcessAlive: () => true,
      });
      await expect(later.acquire()).resolves.toBeUndefined();
      later.release();
    });
  });

  it('releases even when the guarded work throws', async () => {
    await withTempProject({}, async (project) => {
      const lock = new ProjectLock(project.path('.lore/lock'));
      await expect(
        lock.withLock(() => {
          throw new Error('build failed');
        }),
      ).rejects.toThrow('build failed');
      expect(lock.held).toBe(false);
      expect(existsSync(project.path('.lore/lock'))).toBe(false);
    });
  });

  it('is a no-op to release a lock it does not hold', async () => {
    await withTempProject({}, (project) => {
      const lock = new ProjectLock(project.path('.lore/lock'));
      expect(() => lock.release()).not.toThrow();
    });
  });
});
