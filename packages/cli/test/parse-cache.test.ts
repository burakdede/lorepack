import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { type CachedParse, ParseCache } from '../src/services/parse-cache.js';

const KEY = 'a'.repeat(64);

const ENTRY: CachedParse = {
  artifact: {
    id: 'p:a.md',
    sourceId: 'p',
    relativePath: 'a.md',
    displayPath: 'a.md',
    mediaType: 'text/markdown',
    byteSize: 3,
    contentHash: 'b'.repeat(64),
    parserId: 'markdown',
    parserVersion: '0.1.0',
    status: 'active',
    authority: 50,
    supersedes: [],
    metadata: {},
  },
  nodes: [],
  chunks: [],
  objectHash: 'c'.repeat(64),
};

describe('parse cache', () => {
  it('round-trips an entry', async () => {
    await withTempProject({}, async (project) => {
      const cache = new ParseCache(project.path('cache'));
      await cache.put(KEY, ENTRY);
      expect(cache.get(KEY)).toEqual(ENTRY);
      expect(cache.hits).toBe(1);
    });
  });

  it('retains parser warnings through a fresh on-disk cache reader', async () => {
    await withTempProject({}, async (project) => {
      const directory = project.path('cache');
      const warnings = [
        { code: 'docx-unmapped-style', message: 'Unmapped Callout style', line: 7 },
      ];
      await new ParseCache(directory).put(KEY, { ...ENTRY, warnings });
      const reader = new ParseCache(directory);
      expect(reader.get(KEY)).toEqual({ ...ENTRY, warnings });
      expect(reader.hits).toBe(1);
      expect(reader.misses).toBe(0);
    });
  });

  it('counts a missing entry as a miss rather than failing', async () => {
    await withTempProject({}, (project) => {
      const cache = new ParseCache(project.path('cache'));
      expect(cache.get(KEY)).toBeNull();
      expect(cache.misses).toBe(1);
    });
  });

  it('treats a corrupt entry as a miss, because a cache must never fail a build', async () => {
    await withTempProject({}, async (project) => {
      const directory = project.path('cache');
      const cache = new ParseCache(directory);
      await cache.put(KEY, ENTRY);

      writeFileSync(join(directory, KEY.slice(0, 2), `${KEY}.json`), '{ truncated', 'utf8');
      expect(cache.get(KEY)).toBeNull();
    });
  });

  it.each([0, 2])('ignores an entry written by an older cache format', async (version) => {
    await withTempProject({}, (project) => {
      const directory = project.path('cache');
      mkdirSync(join(directory, KEY.slice(0, 2)), { recursive: true });
      writeFileSync(
        join(directory, KEY.slice(0, 2), `${KEY}.json`),
        JSON.stringify({ version, ...ENTRY }),
        'utf8',
      );
      expect(new ParseCache(directory).get(KEY)).toBeNull();
    });
  });

  it('shards by key prefix rather than filling one directory', async () => {
    await withTempProject({}, async (project) => {
      const cache = new ParseCache(project.path('cache'));
      await cache.put(KEY, ENTRY);
      expect(existsSync(project.path(`cache/aa/${KEY}.json`))).toBe(true);
    });
  });

  it('survives an unwritable cache directory without throwing', async () => {
    // A read-only volume or a full disk must degrade to "no caching", not to a failed
    // build that was otherwise complete.
    //
    // The cache is pointed at a regular file, so creating a directory beneath it fails on
    // every platform. An absolute path under a nonexistent root does not: on Windows it
    // resolves against the current drive and the write succeeds.
    await withTempProject({ files: { blocker: 'not a directory' } }, async (project) => {
      const cache = new ParseCache(project.path('blocker'));
      await expect(cache.put(KEY, ENTRY)).resolves.toBeUndefined();
      expect(cache.get(KEY)).toBeNull();
    });
  });

  it('keeps the caller responsive while a cache write is pending', async () => {
    await withTempProject({}, async (project) => {
      let writerStarted = false;
      let releaseStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        releaseStarted = resolve;
      });
      const cache = new ParseCache(project.path('cache'), {
        writeFileAtomic: async () => {
          writerStarted = true;
          releaseStarted?.();
          await new Promise((resolve) => setTimeout(resolve, 25));
        },
      });

      const pending = cache.put(KEY, ENTRY);
      const writeStarted = await Promise.race([
        started.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      expect(writeStarted).toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(writerStarted).toBe(true);
      await pending;
    });
  });
});
