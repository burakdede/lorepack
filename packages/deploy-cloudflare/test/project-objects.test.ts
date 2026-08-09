import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashBytes, type LoreError, objectKey } from '@lorepack/core';
import { afterEach, describe, expect, it } from 'vitest';
import { uploadProjectObjects } from '../src/project-objects.js';
import { r2ObjectKey } from '../src/r2-keys.js';

const PROJECT = 'contracted';

class FakeR2Bucket {
  readonly objects = new Map<string, Uint8Array>();
  putFailures = new Map<string, number>();
  putDelayMs = 0;

  async put(key: string, value: Uint8Array): Promise<void> {
    const failures = this.putFailures.get(key) ?? 0;
    if (failures > 0) {
      this.putFailures.set(key, failures - 1);
      const error = new Error('temporary timeout');
      (error as Error & { code?: string }).code = 'ETIMEDOUT';
      throw error;
    }
    if (this.putDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.putDelayMs));
    }
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

const directories: string[] = [];

function makeBuildDirectory(objects: Readonly<Record<string, string>>): {
  readonly buildDirectory: string;
  readonly objectsDirectory: string;
  readonly hashes: readonly string[];
} {
  const root = mkdtempSync(join(tmpdir(), 'lore-build-'));
  directories.push(root);
  const buildDirectory = join(root, 'build');
  const objectsDirectory = join(root, 'objects');

  mkdirSync(buildDirectory, { recursive: true });
  mkdirSync(objectsDirectory, { recursive: true });

  const hashes = Object.values(objects).map((body) => hashBytes(new TextEncoder().encode(body)));

  const db = new DatabaseSync(join(buildDirectory, 'context.sqlite'), {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  db.exec(`CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    object_hash TEXT NOT NULL
  ) STRICT`);

  Object.entries(objects).forEach(([id, body], index) => {
    const bytes = new TextEncoder().encode(body);
    const hash = hashBytes(bytes);
    const path = join(objectsDirectory, ...objectKey(hash).split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
    db.prepare('INSERT INTO artifacts (id, object_hash) VALUES (?, ?)').run(id, hash);

    if (index === 0) {
      db.prepare('INSERT INTO artifacts (id, object_hash) VALUES (?, ?)').run(`${id}@dup`, hash);
    }
  });
  db.close();

  return { buildDirectory, objectsDirectory, hashes };
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

describe('uploadProjectObjects, issue 88', () => {
  it('uploads each referenced object once under the project namespace', async () => {
    const fixture = makeBuildDirectory({
      'contracted:guides/rollback.md': 'rollback body',
      'contracted:guides/history.md': 'history body',
    });
    const bucket = new FakeR2Bucket();

    const result = await uploadProjectObjects({
      bucket,
      projectId: PROJECT,
      buildDirectory: fixture.buildDirectory,
      objectsDirectory: fixture.objectsDirectory,
    });

    expect(result).toEqual({
      referencedObjects: 2,
      uploadedObjects: 2,
      skippedObjects: 0,
      verifiedObjects: 2,
    });
    expect([...bucket.objects.keys()].sort()).toEqual(
      fixture.hashes.map((hash) => r2ObjectKey(PROJECT, hash)).sort(),
    );
  });

  it('skips objects that are already present and verified', async () => {
    const fixture = makeBuildDirectory({
      'contracted:guides/rollback.md': 'rollback body',
      'contracted:guides/history.md': 'history body',
    });
    const bucket = new FakeR2Bucket();

    const existingHash = fixture.hashes[0] as string;
    bucket.objects.set(
      r2ObjectKey(PROJECT, existingHash),
      new TextEncoder().encode('rollback body'),
    );

    const result = await uploadProjectObjects({
      bucket,
      projectId: PROJECT,
      buildDirectory: fixture.buildDirectory,
      objectsDirectory: fixture.objectsDirectory,
    });

    expect(result).toEqual({
      referencedObjects: 2,
      uploadedObjects: 1,
      skippedObjects: 1,
      verifiedObjects: 2,
    });
  });

  it('fails when an existing remote object is corrupt', async () => {
    const fixture = makeBuildDirectory({
      'contracted:guides/rollback.md': 'rollback body',
    });
    const bucket = new FakeR2Bucket();
    const hash = fixture.hashes[0] as string;
    bucket.objects.set(r2ObjectKey(PROJECT, hash), new TextEncoder().encode('tampered'));

    try {
      await uploadProjectObjects({
        bucket,
        projectId: PROJECT,
        buildDirectory: fixture.buildDirectory,
        objectsDirectory: fixture.objectsDirectory,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as LoreError).code).toBe('LORE_E_OBJECT_CORRUPT');
      expect((error as LoreError).subject).toBe(hash);
    }
  });

  it('retries a transient object upload failure and eventually succeeds', async () => {
    const fixture = makeBuildDirectory({
      'contracted:guides/rollback.md': 'rollback body',
    });
    const bucket = new FakeR2Bucket();
    const hash = fixture.hashes[0] as string;
    bucket.putFailures.set(r2ObjectKey(PROJECT, hash), 1);

    const result = await uploadProjectObjects({
      bucket,
      projectId: PROJECT,
      buildDirectory: fixture.buildDirectory,
      objectsDirectory: fixture.objectsDirectory,
      retryDelayMs: 0,
      sleep: async () => {},
    });

    expect(result).toEqual({
      referencedObjects: 1,
      uploadedObjects: 1,
      skippedObjects: 0,
      verifiedObjects: 1,
    });
    expect(bucket.objects.has(r2ObjectKey(PROJECT, hash))).toBe(true);
  });

  it('emits repeated progress updates during a slow object upload', async () => {
    const fixture = makeBuildDirectory({
      'contracted:guides/rollback.md': 'rollback body',
    });
    const bucket = new FakeR2Bucket();
    bucket.putDelayMs = 90;
    const updates: {
      completedBytes: number;
      totalBytes: number;
      completedObjects: number;
      totalObjects: number;
      uploadedObjects: number;
      skippedObjects: number;
    }[] = [];

    const result = await uploadProjectObjects({
      bucket,
      projectId: PROJECT,
      buildDirectory: fixture.buildDirectory,
      objectsDirectory: fixture.objectsDirectory,
      progressIntervalMs: 25,
      onProgress: (update) => {
        updates.push(update);
      },
    });

    expect(result).toEqual({
      referencedObjects: 1,
      uploadedObjects: 1,
      skippedObjects: 0,
      verifiedObjects: 1,
    });
    expect(
      updates.filter(
        (update) =>
          update.completedBytes === 0 &&
          update.completedObjects === 0 &&
          update.uploadedObjects === 0 &&
          update.skippedObjects === 0,
      ),
    ).toHaveLength(3);
    expect(updates.at(-1)).toMatchObject({
      completedObjects: 1,
      totalObjects: 1,
      uploadedObjects: 1,
      skippedObjects: 0,
    });
  });
});
