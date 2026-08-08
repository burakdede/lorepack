import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashBytes, LoreError, objectKey } from '@lorepack/core';
import { r2ObjectKey } from './r2-keys.js';
import type { R2BucketLike } from './storage.js';

interface BuildArtifactRow {
  readonly object_hash: string;
}

export interface ProjectObjectUploadOptions {
  readonly bucket: R2BucketLike;
  readonly projectId: string;
  readonly buildDirectory: string;
  readonly objectsDirectory: string;
  readonly retryAttempts?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onProgress?: (update: {
    readonly completedBytes: number;
    readonly totalBytes: number;
    readonly completedObjects: number;
    readonly totalObjects: number;
    readonly uploadedObjects: number;
    readonly skippedObjects: number;
  }) => void;
}

export interface ProjectObjectUploadResult {
  readonly referencedObjects: number;
  readonly uploadedObjects: number;
  readonly skippedObjects: number;
  readonly verifiedObjects: number;
}

const BUILD_OBJECTS_QUERY = `SELECT DISTINCT object_hash
FROM artifacts
ORDER BY object_hash`;

export async function uploadProjectObjects(
  options: ProjectObjectUploadOptions,
): Promise<ProjectObjectUploadResult> {
  const buildDatabase = openBuildDatabase(options.buildDirectory);
  const retry = retryPolicy(options);

  try {
    const objectHashes = (
      buildDatabase.prepare(BUILD_OBJECTS_QUERY).all() as unknown as BuildArtifactRow[]
    ).map((row) => row.object_hash);
    const totalBytes = objectHashes.reduce(
      (sum, hash) => sum + localObjectSize(options.objectsDirectory, hash),
      0,
    );

    let uploadedObjects = 0;
    let skippedObjects = 0;
    let verifiedObjects = 0;
    let completedBytes = 0;

    for (const hash of objectHashes) {
      const key = r2ObjectKey(options.projectId, hash);
      const existing = await withRetries(
        () => options.bucket.head(key),
        retry,
        `inspect remote object ${hash}`,
        hash,
      );
      const sizeBytes = localObjectSize(options.objectsDirectory, hash);

      if (existing !== null) {
        await verifyRemoteObject(options.bucket, key, hash, retry);
        skippedObjects += 1;
        verifiedObjects += 1;
        completedBytes += sizeBytes;
        options.onProgress?.({
          completedBytes,
          totalBytes,
          completedObjects: verifiedObjects,
          totalObjects: objectHashes.length,
          uploadedObjects,
          skippedObjects,
        });
        continue;
      }

      const bytes = readLocalObject(options.objectsDirectory, hash);
      await withRetries(() => options.bucket.put(key, bytes), retry, `upload object ${hash}`, hash);
      await verifyRemoteObject(options.bucket, key, hash, retry);
      uploadedObjects += 1;
      verifiedObjects += 1;
      completedBytes += bytes.byteLength;
      options.onProgress?.({
        completedBytes,
        totalBytes,
        completedObjects: verifiedObjects,
        totalObjects: objectHashes.length,
        uploadedObjects,
        skippedObjects,
      });
    }

    return {
      referencedObjects: objectHashes.length,
      uploadedObjects,
      skippedObjects,
      verifiedObjects,
    };
  } finally {
    buildDatabase.close();
  }
}

function openBuildDatabase(buildDirectory: string): DatabaseSync {
  const path = join(buildDirectory, 'context.sqlite');
  if (!existsSync(path)) {
    throw new LoreError(
      'LORE_E_BUILD_NOT_FOUND',
      `Build ${buildDirectory} has no context.sqlite.`,
      {
        remediation: 'Upload objects only from a verified sealed build directory.',
        subject: path,
      },
    );
  }

  try {
    return new DatabaseSync(path, {
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
  } catch (cause) {
    throw new LoreError('LORE_E_SQLITE_UNAVAILABLE', `Cannot open ${path} for reading.`, {
      remediation: 'Check that the sealed build exists and is readable.',
      cause,
    });
  }
}

function localObjectSize(objectsDirectory: string, hash: string): number {
  const path = join(objectsDirectory, ...objectKey(hash).split('/'));
  if (!existsSync(path)) {
    throw new LoreError(
      'LORE_E_OBJECT_CORRUPT',
      `Build object ${hash} is missing from ${objectsDirectory}.`,
      {
        remediation: 'Rebuild so the normalized object cache is complete, then deploy again.',
        subject: hash,
        details: { path },
      },
    );
  }
  return statSync(path).size;
}

function readLocalObject(objectsDirectory: string, hash: string): Uint8Array {
  const path = join(objectsDirectory, ...objectKey(hash).split('/'));
  if (!existsSync(path)) {
    throw new LoreError(
      'LORE_E_OBJECT_CORRUPT',
      `Build object ${hash} is missing from ${objectsDirectory}.`,
      {
        remediation: 'Rebuild so the normalized object cache is complete, then deploy again.',
        subject: hash,
        details: { path },
      },
    );
  }

  const bytes = new Uint8Array(readFileSync(path));
  const actual = hashBytes(bytes);
  if (actual !== hash) {
    throw new LoreError(
      'LORE_E_OBJECT_CORRUPT',
      `Build object ${hash} failed its checksum before upload.`,
      {
        remediation: 'Rebuild so the normalized object cache is regenerated, then deploy again.',
        subject: hash,
        details: { expected: hash, actual, path },
      },
    );
  }
  return bytes;
}

async function verifyRemoteObject(
  bucket: R2BucketLike,
  key: string,
  hash: string,
  retry: RetryPolicy,
): Promise<void> {
  const object = await withRetries(
    () => bucket.get(key),
    retry,
    `read uploaded object ${hash}`,
    hash,
  );
  if (object === null) {
    throw new LoreError(
      'LORE_E_OBJECT_CORRUPT',
      `Uploaded object ${hash} was not readable from remote storage.`,
      {
        remediation: 'Deploy again. If this recurs, the remote object store is not durable.',
        subject: hash,
        details: { key },
      },
    );
  }

  const bytes = new Uint8Array(await object.arrayBuffer());
  const actual = hashBytes(bytes);
  if (actual !== hash) {
    throw new LoreError(
      'LORE_E_OBJECT_CORRUPT',
      `Uploaded object ${hash} failed remote checksum verification.`,
      {
        remediation:
          'Deploy again so the object is uploaded cleanly. If this recurs, the remote bucket contents are damaged.',
        subject: hash,
        details: { expected: hash, actual, key },
      },
    );
  }
}

interface RetryPolicy {
  readonly attempts: number;
  readonly delayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

function retryPolicy(
  options: Pick<ProjectObjectUploadOptions, 'retryAttempts' | 'retryDelayMs' | 'sleep'>,
): RetryPolicy {
  return {
    attempts: options.retryAttempts ?? 3,
    delayMs: options.retryDelayMs ?? 250,
    sleep: options.sleep ?? defaultSleep,
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
