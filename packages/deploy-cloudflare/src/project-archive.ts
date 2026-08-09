import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectBuildMembers, collectObjects, writeArchive } from '@lorepack/backend-local';
import { hashBytes, LoreError } from '@lorepack/core';
import { r2ArchiveKey } from './r2-keys.js';
import type { R2BucketLike } from './storage.js';
import { withProgressHeartbeat } from './upload-progress.js';

interface BuildReferenceRow {
  readonly object_hash: string;
}

export interface ProjectArchiveUploadOptions {
  readonly bucket: R2BucketLike;
  readonly projectId: string;
  readonly buildId: string;
  readonly buildDirectory: string;
  readonly objectsDirectory: string;
  readonly retryAttempts?: number;
  readonly retryDelayMs?: number;
  readonly progressIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
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
  const retry = retryPolicy(options);

  const existing = await withRetries(
    () => options.bucket.head(key),
    retry,
    `inspect remote archive ${key}`,
    key,
  );
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

  await withRetries(
    () =>
      withProgressHeartbeat(
        options.progressIntervalMs ?? 1000,
        () => {
          options.onProgress?.({
            completedBytes: 0,
            totalBytes: archive.bytes.byteLength,
            detail: 'archive upload in progress',
          });
        },
        () => options.bucket.put(key, archive.bytes),
      ),
    retry,
    `upload archive ${key}`,
    key,
  );
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
  const object = await withRetries(
    () => bucket.get(key),
    defaultRetryPolicy(),
    `read uploaded archive ${key}`,
    key,
  );
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

interface RetryPolicy {
  readonly attempts: number;
  readonly delayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

function retryPolicy(
  options: Pick<ProjectArchiveUploadOptions, 'retryAttempts' | 'retryDelayMs' | 'sleep'>,
): RetryPolicy {
  return {
    attempts: options.retryAttempts ?? 3,
    delayMs: options.retryDelayMs ?? 250,
    sleep: options.sleep ?? defaultSleep,
  };
}

function defaultRetryPolicy(): RetryPolicy {
  return {
    attempts: 3,
    delayMs: 250,
    sleep: defaultSleep,
  };
}

async function withRetries<T>(
  work: () => Promise<T>,
  policy: RetryPolicy,
  action: string,
  subject: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === policy.attempts) {
        throw new LoreError('LORE_E_REMOTE_DEPLOY', `Could not ${action}.`, {
          remediation:
            'Retry the deploy. If this recurs, the remote object store or network path is unstable.',
          subject,
          cause: error,
        });
      }
      await policy.sleep(policy.delayMs * attempt);
    }
  }

  throw lastError;
}

function isTransient(error: unknown): boolean {
  const message = String(
    (error as { message?: unknown }).message ?? (error as { code?: unknown }).code ?? error,
  ).toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('temporar') ||
    message.includes('unavailable') ||
    message.includes('rate limit') ||
    message.includes('429')
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
