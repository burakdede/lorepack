import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyArchive } from '@lorepack/backend-local';
import { hashBytes, type LoreError, objectKey } from '@lorepack/core';
import { afterEach, describe, expect, it } from 'vitest';
import { uploadProjectArchive } from '../src/project-archive.js';
import { r2ArchiveKey } from '../src/r2-keys.js';

const PROJECT = 'contracted';
const BUILD = `lore_${'a'.repeat(64)}`;

class FakeR2Bucket {
  readonly objects = new Map<string, Uint8Array>();
  putFailures = 0;

  async put(key: string, value: Uint8Array): Promise<void> {
    if (this.putFailures > 0) {
      this.putFailures -= 1;
      const error = new Error('temporary timeout');
      (error as Error & { code?: string }).code = 'ETIMEDOUT';
      throw error;
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

function makeBuildDirectory(body: string): {
  readonly buildDirectory: string;
  readonly objectsDirectory: string;
  readonly hash: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'lore-build-'));
  directories.push(root);
  const buildDirectory = join(root, 'build');
  const objectsDirectory = join(root, 'objects');

  mkdirSync(join(buildDirectory, 'reports'), { recursive: true });
  mkdirSync(objectsDirectory, { recursive: true });

  writeFileSync(
    join(buildDirectory, 'manifest.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        buildId: BUILD,
        projectName: PROJECT,
        compilerVersion: '0.1.0',
        schemaVersion: 1,
        configurationHash: 'c'.repeat(64),
        sourceFingerprint: 'd'.repeat(64),
        canonicalRoots: {
          artifacts: '1'.repeat(64),
          nodes: '2'.repeat(64),
          chunks: '3'.repeat(64),
          tables: '4'.repeat(64),
          objects: '5'.repeat(64),
        },
        capabilities: ['lexical-search', 'structured-context'],
        counts: { artifacts: 1, nodes: 1, chunks: 0, tables: 0, tableRows: 0 },
        warnings: [],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(buildDirectory, 'reports', 'warnings.json'), '[]\n');

  const db = new DatabaseSync(join(buildDirectory, 'context.sqlite'), {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  db.exec(`CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    object_hash TEXT NOT NULL
  ) STRICT`);

  const bytes = new TextEncoder().encode(body);
  const hash = hashBytes(bytes);
  const path = join(objectsDirectory, ...objectKey(hash).split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
  db.prepare('INSERT INTO artifacts (id, object_hash) VALUES (?, ?)').run(
    'contracted:guides/rollback.md',
    hash,
  );
  db.close();

  return { buildDirectory, objectsDirectory, hash };
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

describe('uploadProjectArchive, issue 88', () => {
  it('uploads a sealed archive under the build-scoped key and verifies it', async () => {
    const fixture = makeBuildDirectory('rollback body');
    const bucket = new FakeR2Bucket();

    const result = await uploadProjectArchive({
      bucket,
      projectId: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      objectsDirectory: fixture.objectsDirectory,
    });

    expect(result).toMatchObject({
      key: r2ArchiveKey(PROJECT, BUILD),
      uploaded: true,
      memberCount: 5,
    });

    const archivePath = join(fixture.buildDirectory, 'downloaded.lorepack');
    writeFileSync(archivePath, bucket.objects.get(result.key) as Uint8Array);
    expect(await verifyArchive(archivePath)).toMatchObject({ ok: true, memberCount: 5 });
  });

  it('skips a previously uploaded archive after verifying it', async () => {
    const fixture = makeBuildDirectory('rollback body');
    const bucket = new FakeR2Bucket();

    const first = await uploadProjectArchive({
      bucket,
      projectId: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      objectsDirectory: fixture.objectsDirectory,
    });
    const second = await uploadProjectArchive({
      bucket,
      projectId: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      objectsDirectory: fixture.objectsDirectory,
    });

    expect(first.key).toBe(second.key);
    expect(second.uploaded).toBe(false);
    expect(second.sha256).toBe(first.sha256);
  });

  it('fails when the existing remote archive is corrupt', async () => {
    const fixture = makeBuildDirectory('rollback body');
    const bucket = new FakeR2Bucket();
    const key = r2ArchiveKey(PROJECT, BUILD);
    bucket.objects.set(key, new TextEncoder().encode('tampered'));

    try {
      await uploadProjectArchive({
        bucket,
        projectId: PROJECT,
        buildId: BUILD,
        buildDirectory: fixture.buildDirectory,
        objectsDirectory: fixture.objectsDirectory,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as LoreError).code).toBe('LORE_E_OBJECT_CORRUPT');
      expect((error as LoreError).subject).toBe(key);
    }
  });

  it('retries a transient archive upload failure and eventually succeeds', async () => {
    const fixture = makeBuildDirectory('rollback body');
    const bucket = new FakeR2Bucket();
    bucket.putFailures = 1;

    const result = await uploadProjectArchive({
      bucket,
      projectId: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      objectsDirectory: fixture.objectsDirectory,
      retryDelayMs: 0,
      sleep: async () => {},
    });

    expect(result.uploaded).toBe(true);
    expect(bucket.objects.has(r2ArchiveKey(PROJECT, BUILD))).toBe(true);
  });
});
