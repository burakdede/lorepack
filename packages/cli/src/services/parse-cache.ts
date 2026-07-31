import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Chunk } from '@lorepack/compiler';
import type { Artifact, LoreNode } from '@lorepack/core';
import { writeFileAtomic } from '@lorepack/core';

/**
 * The parse cache behind incremental builds.
 *
 * Keyed by `cacheKey` (architecture section 12.3), which covers content, parser identity,
 * normalization version and the configuration that affects output. That is what makes a
 * hit safe: anything that could change the parsed result changes the key, so a stale entry
 * is unreachable rather than merely unlikely.
 *
 * The cache is an optimisation and nothing more. A corrupt, truncated or unreadable entry
 * is treated as a miss, never as an error: a build must never fail because of a cache.
 */

export interface CachedParse {
  readonly artifact: Artifact;
  readonly nodes: readonly LoreNode[];
  readonly chunks: readonly Chunk[];
  readonly objectHash: string;
}

interface CacheEnvelope extends CachedParse {
  readonly version: number;
}

/** Bumped when the cached shape changes, so old entries are ignored instead of misread. */
const CACHE_FORMAT_VERSION = 1;

export class ParseCache {
  readonly #directory: string;
  #hits = 0;
  #misses = 0;

  constructor(directory: string) {
    this.#directory = directory;
  }

  get hits(): number {
    return this.#hits;
  }

  get misses(): number {
    return this.#misses;
  }

  get(key: string): CachedParse | null {
    const path = this.#pathFor(key);
    if (!existsSync(path)) {
      this.#misses += 1;
      return null;
    }

    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as CacheEnvelope;
      if (parsed.version !== CACHE_FORMAT_VERSION || typeof parsed.objectHash !== 'string') {
        this.#misses += 1;
        return null;
      }
      this.#hits += 1;
      return {
        artifact: parsed.artifact,
        nodes: parsed.nodes,
        chunks: parsed.chunks,
        objectHash: parsed.objectHash,
      };
    } catch {
      this.#misses += 1;
      return null;
    }
  }

  put(key: string, value: CachedParse): void {
    const envelope: CacheEnvelope = { version: CACHE_FORMAT_VERSION, ...value };
    try {
      mkdirSync(join(this.#directory, key.slice(0, 2)), { recursive: true });
      writeFileAtomic(this.#pathFor(key), JSON.stringify(envelope));
    } catch {
      // A cache that cannot be written (read-only volume, full disk) must not fail a build
      // that is otherwise complete.
    }
  }

  clear(): void {
    rmSync(this.#directory, { recursive: true, force: true, maxRetries: 3 });
  }

  /** Sharded by the first byte of the key: a flat directory of 50,000 entries is slow to
   * enumerate on every platform we support. */
  #pathFor(key: string): string {
    return join(this.#directory, key.slice(0, 2), `${key}.json`);
  }
}
