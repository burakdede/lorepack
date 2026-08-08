import { type BuildId, hashBytes, type LoreError } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import {
  D1ActiveBuildProvider,
  type D1DatabaseLike,
  R2ObjectStore,
  r2ObjectKey,
} from '../src/storage.js';

const buildId = (seed: string): BuildId => `lore_${seed.repeat(64).slice(0, 64)}` as BuildId;
const BUILD_A = buildId('a');
const BUILD_B = buildId('b');
const PROJECT = 'demo';

class FakeR2Bucket {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(value));
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return {
      arrayBuffer: async () =>
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer,
    };
  }

  async head(key: string): Promise<Record<string, never> | null> {
    return this.objects.has(key) ? {} : null;
  }
}

class FakeD1Database implements D1DatabaseLike {
  row: { buildId: string | null; generation: number } | null;

  constructor(row: { buildId: string | null; generation: number } | null) {
    this.row = row;
  }

  prepare(_query: string) {
    return {
      first: async <T>() => this.row as T | null,
    };
  }
}

describe('R2ObjectStore', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('round-trips content and returns its hash', async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2ObjectStore(PROJECT, bucket);

    const hash = await store.put(bytes('hello world'));

    expect(hash).toBe(hashBytes(bytes('hello world')));
    expect([...bucket.objects.keys()]).toEqual([r2ObjectKey(PROJECT, hash)]);
    expect(new TextDecoder().decode((await store.get(hash)) ?? new Uint8Array())).toBe(
      'hello world',
    );
    expect(await store.has(hash)).toBe(true);
  });

  it('returns null for an unknown hash rather than throwing', async () => {
    const store = new R2ObjectStore(PROJECT, new FakeR2Bucket());
    expect(await store.get('f'.repeat(64))).toBeNull();
    expect(await store.has('f'.repeat(64))).toBe(false);
  });

  it('deduplicates identical content without rewriting', async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2ObjectStore(PROJECT, bucket);

    const first = await store.put(bytes('same'));
    const second = await store.put(bytes('same'));

    expect(second).toBe(first);
    expect(bucket.objects.size).toBe(1);
  });

  it('detects corruption on read and names the hash', async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2ObjectStore(PROJECT, bucket);
    const hash = await store.put(bytes('original'));
    const key = r2ObjectKey(PROJECT, hash);
    bucket.objects.set(key, bytes('tampered'));

    await expect(store.get(hash)).rejects.toMatchObject({
      code: 'LORE_E_OBJECT_CORRUPT',
      subject: hash,
    });
  });

  it('does not read another project namespace', async () => {
    const hash = hashBytes(bytes('shared'));
    const bucket = new FakeR2Bucket();
    bucket.objects.set(r2ObjectKey('other', hash), bytes('shared'));

    const store = new R2ObjectStore(PROJECT, bucket);

    expect(await store.get(hash)).toBeNull();
    expect(await store.has(hash)).toBe(false);
  });
});

describe('D1ActiveBuildProvider', () => {
  it('starts with no active build', async () => {
    const provider = new D1ActiveBuildProvider(new FakeD1Database(null));
    expect(await provider.current()).toBeNull();
  });

  it('fails with an actionable error when nothing is active', async () => {
    const provider = new D1ActiveBuildProvider(new FakeD1Database(null));

    try {
      await provider.acquire();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as LoreError).code).toBe('LORE_E_BUILD_NOT_FOUND');
      expect((error as LoreError).remediation).toContain('Deploy and activate');
    }
  });

  it('returns the current build id and generation', async () => {
    const provider = new D1ActiveBuildProvider(
      new FakeD1Database({ buildId: BUILD_A, generation: 7 }),
    );

    expect(await provider.current()).toEqual({ buildId: BUILD_A, generation: 7 });
  });

  it('lets an in-flight request finish on its build while the next sees the new one', async () => {
    const db = new FakeD1Database({ buildId: BUILD_A, generation: 1 });
    const provider = new D1ActiveBuildProvider(db);

    const inFlight = await provider.acquire();
    expect(inFlight.buildId).toBe(BUILD_A);

    db.row = { buildId: BUILD_B, generation: 2 };

    const next = await provider.acquire();
    expect(next.buildId).toBe(BUILD_B);
    expect(next.generation).toBeGreaterThan(inFlight.generation);
    expect(inFlight.buildId).toBe(BUILD_A);

    expect(() => inFlight.release()).not.toThrow();
    expect(() => next.release()).not.toThrow();
  });
});
