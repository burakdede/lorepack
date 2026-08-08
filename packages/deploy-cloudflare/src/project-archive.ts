import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectBuildMembers, collectObjects, writeArchive } from '@lorepack/backend-local';
import { hashBytes, LoreError } from '@lorepack/core';
import { r2ArchiveKey } from './r2-keys.js';
import type { R2BucketLike } from './storage.js';

interface BuildReferenceRow {
  readonly object_hash: string;
}

export interface ProjectArchiveUploadOptions {
  readonly bucket: R2BucketLike;
  readonly projectId: string;
  readonly buildId: string;
  readonly buildDirectory: string;
  readonly objectsDirectory: string;
  readonly onProgress?: (update: {
    readonly completedBytes: number;
    readonly totalBytes: number;
    readonly detail: string;
  }) => void;
}

export interface ProjectArchiveUploadResult {
  readonly key: string;
  readonly uploaded: boolean;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly memberCount: number;
}

export async function uploadProjectArchive(
  options: ProjectArchiveUploadOptions,
): Promise<ProjectArchiveUploadResult> {
  const archive = await buildArchive(options.buildDirectory, options.objectsDirectory);
  const key = r2ArchiveKey(options.projectId, options.buildId);
  const sha256 = hashBytes(archive.bytes);

  const existing = await options.bucket.head(key);
  if (existing !== null) {
    await verifyRemoteArchive(options.bucket, key, sha256);
    options.onProgress?.({
      completedBytes: archive.bytes.byteLength,
      totalBytes: archive.bytes.byteLength,
      detail: 'archive verified',
    });
    return {
      key,
      uploaded: false,
      sizeBytes: archive.bytes.byteLength,
      sha256,
      memberCount: archive.memberCount,
    };
  }

  await options.bucket.put(key, archive.bytes);
  await verifyRemoteArchive(options.bucket, key, sha256);
  options.onProgress?.({
    completedBytes: archive.bytes.byteLength,
    totalBytes: archive.bytes.byteLength,
    detail: 'archive uploaded',
  });

  return {
    key,
    uploaded: true,
    sizeBytes: archive.bytes.byteLength,
    sha256,
    memberCount: archive.memberCount,
  };
}

async function buildArchive(
  buildDirectory: string,
  objectsDirectory: string,
): Promise<{
  readonly bytes: Uint8Array;
  readonly memberCount: number;
}> {
  const objectHashes = readObjectHashes(buildDirectory);
  const members = collectBuildMembers(
    buildDirectory,
    collectObjects(objectsDirectory, objectHashes),
  );
  const working = mkdtempSync(join(tmpdir(), 'lore-r2-archive-'));
  const path = join(working, 'build.lorepack');

  return await withCleanup(working, async () => {
    await writeArchive(path, members);
    return {
      bytes: new Uint8Array(readFileSync(path)),
      memberCount: members.length + 1,
    };
  });
}

function readObjectHashes(buildDirectory: string): string[] {
  const path = join(buildDirectory, 'context.sqlite');
  if (!existsSync(path)) {
    throw new LoreError(
      'LORE_E_BUILD_NOT_FOUND',
      `Build ${buildDirectory} has no context.sqlite.`,
      {
        remediation: 'Upload archives only from a verified sealed build directory.',
        subject: path,
      },
    );
  }

  const db = new DatabaseSync(path, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });

  try {
    const rows = db
      .prepare('SELECT DISTINCT object_hash FROM artifacts ORDER BY object_hash')
      .all() as unknown as BuildReferenceRow[];
    return rows.map((row) => row.object_hash);
  } finally {
    db.close();
  }
}

async function verifyRemoteArchive(
  bucket: R2BucketLike,
  key: string,
  expected: string,
): Promise<void> {
  const object = await bucket.get(key);
  if (object === null) {
    throw new LoreError(
      'LORE_E_OBJECT_CORRUPT',
      `Uploaded archive ${key} was not readable from remote storage.`,
      {
        remediation: 'Deploy again. If this recurs, the remote object store is not durable.',
        subject: key,
      },
    );
  }

  const bytes = new Uint8Array(await object.arrayBuffer());
  const actual = hashBytes(bytes);
  if (actual !== expected) {
    throw new LoreError(
      'LORE_E_OBJECT_CORRUPT',
      `Uploaded archive ${key} failed remote verification.`,
      {
        remediation:
          'Deploy again so the archive is uploaded cleanly. If this recurs, the remote bucket contents are damaged.',
        subject: key,
        details: { expected, actual },
      },
    );
  }
}

function withCleanup<T>(directory: string, body: () => Promise<T>): Promise<T> {
  return body().finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}
