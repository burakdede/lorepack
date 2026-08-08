import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashBytes, LoreError, objectKey } from '@lorepack/core';
import { r2ObjectKey, type R2BucketLike } from './storage.js';

interface BuildArtifactRow {
  readonly object_hash: string;
}

export interface ProjectObjectUploadOptions {
  readonly bucket: R2BucketLike;
  readonly projectId: string;
  readonly buildDirectory: string;
  readonly objectsDirectory: string;
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

  try {
    const objectHashes = (
      buildDatabase.prepare(BUILD_OBJECTS_QUERY).all() as unknown as BuildArtifactRow[]
    ).map((row) => row.object_hash);

    let uploadedObjects = 0;
    let skippedObjects = 0;
    let verifiedObjects = 0;

    for (const hash of objectHashes) {
      const key = r2ObjectKey(options.projectId, hash);
      const existing = await options.bucket.head(key);

      if (existing !== null) {
        await verifyRemoteObject(options.bucket, key, hash);
        skippedObjects += 1;
        verifiedObjects += 1;
        continue;
      }

      const bytes = readLocalObject(options.objectsDirectory, hash);
      await options.bucket.put(key, bytes);
      await verifyRemoteObject(options.bucket, key, hash);
      uploadedObjects += 1;
      verifiedObjects += 1;
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

async function verifyRemoteObject(bucket: R2BucketLike, key: string, hash: string): Promise<void> {
  const object = await bucket.get(key);
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
