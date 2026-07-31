import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalStateStore, openReadOnly } from '@lorepack/backend-local';
import type { BuildSnapshot } from '@lorepack/compiler';
import {
  assertBuildId,
  type BuildId,
  type BuildSummary,
  buildManifestSchema,
  LoreError,
} from '@lorepack/core';
import { STATE_MIGRATIONS } from './migrations-path.js';

/**
 * Reading sealed builds: history, resolution of a short id, and the snapshot the diff
 * engine works on.
 *
 * Everything here reads build data only. Nothing re-parses a source, which is what lets
 * `lore diff` and `lore rollback` work in a project whose source directory has been
 * deleted, and what makes both operations instant.
 */

export function openStateStore(loreDirectory: string): LocalStateStore {
  if (!existsSync(join(loreDirectory, 'state.sqlite'))) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no builds yet.', {
      remediation: 'Run `lore build` to create the first one.',
    });
  }
  return LocalStateStore.open(loreDirectory, STATE_MIGRATIONS);
}

/**
 * Resolves a full id or an unambiguous prefix.
 *
 * An ambiguous prefix lists the candidates rather than picking one. Silently choosing
 * would mean activating a build the user did not name.
 */
export function resolveBuildId(builds: readonly BuildSummary[], reference: string): BuildId {
  const needle = reference.trim();
  if (needle === '') {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', 'No build was named.', {
      remediation: 'Pass a build id, or run `lore builds` to list them.',
    });
  }

  const exact = builds.find((build) => build.buildId === needle);
  if (exact !== undefined) return exact.buildId;

  const matches = builds.filter((build) => build.buildId.startsWith(needle));
  if (matches.length === 1) return (matches[0] as BuildSummary).buildId;

  if (matches.length === 0) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No build matches ${needle}.`, {
      remediation:
        builds.length === 0
          ? 'Run `lore build` to create one.'
          : `Available builds:\n${builds.map((build) => `  ${build.buildId}`).join('\n')}`,
      subject: needle,
    });
  }

  throw new LoreError('LORE_E_INVALID_ARGUMENT', `${needle} matches ${matches.length} builds.`, {
    remediation: `Use a longer prefix. Candidates:\n${matches
      .map((build) => `  ${build.buildId}`)
      .join('\n')}`,
    subject: needle,
  });
}

export function buildDirectory(loreDirectory: string, buildId: BuildId): string {
  return join(loreDirectory, 'builds', buildId);
}

/** Reads the canonical records a diff compares, straight out of the sealed build. */
export function readSnapshot(loreDirectory: string, buildId: BuildId): BuildSnapshot {
  const directory = buildDirectory(loreDirectory, buildId);
  const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `Build ${buildId} has no manifest.`, {
      remediation: 'The build directory is incomplete. Rebuild, or activate another build.',
      subject: buildId,
    });
  }

  const manifest = buildManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const db = openReadOnly(join(directory, 'context.sqlite'));
  try {
    const artifacts = db
      .prepare(
        'SELECT id, relative_path, content_hash, status, authority FROM artifacts ORDER BY id',
      )
      .all() as Array<{
      id: string;
      relative_path: string;
      content_hash: string;
      status: string;
      authority: number;
    }>;

    const supersessions = db
      .prepare('SELECT artifact_id, superseded_id FROM supersessions')
      .all() as Array<{ artifact_id: string; superseded_id: string }>;
    const superseded = new Map<string, string[]>();
    for (const row of supersessions) {
      const list = superseded.get(row.artifact_id) ?? [];
      list.push(row.superseded_id);
      superseded.set(row.artifact_id, list);
    }

    const chunks = db.prepare('SELECT id, revision_hash FROM chunks ORDER BY id').all() as Array<{
      id: string;
      revision_hash: string;
    }>;

    return {
      buildId,
      formatVersion: manifest.formatVersion,
      schemaVersion: manifest.schemaVersion,
      compilerVersion: manifest.compilerVersion,
      capabilities: manifest.capabilities,
      canonicalRoots: manifest.canonicalRoots,
      artifacts: artifacts.map((row) => ({
        id: row.id,
        relativePath: row.relative_path,
        contentHash: row.content_hash,
        status: row.status,
        authority: Number(row.authority),
        supersedes: superseded.get(row.id) ?? [],
      })),
      chunks: chunks.map((row) => ({ id: row.id, revisionHash: row.revision_hash })),
      // Tables arrive in Phase 5. The shape is fixed now so diff output does not change
      // when they do.
      tables: [],
    };
  } finally {
    db.close();
  }
}

/**
 * Pre-flight before a pointer change: the build exists, passed validation, its database
 * opens, and its integrity check passes.
 *
 * Activation is cheap, but activating a corrupt build is not, so the check happens before
 * the pointer moves rather than at the first request that fails.
 */
export function assertActivatable(loreDirectory: string, build: BuildSummary): void {
  if (build.state !== 'verified' && build.state !== 'active') {
    throw new LoreError(
      'LORE_E_BUILD_VALIDATION',
      `Build ${build.buildId} is ${build.state}, and only a verified build may be activated.`,
      {
        remediation: 'Activate a build that passed validation, or run `lore build` again.',
        subject: build.buildId,
      },
    );
  }

  const databasePath = join(buildDirectory(loreDirectory, build.buildId), 'context.sqlite');
  if (!existsSync(databasePath)) {
    throw new LoreError(
      'LORE_E_BUILD_NOT_FOUND',
      `Build ${build.buildId} is recorded but its files are missing.`,
      {
        remediation: 'Run `lore build` to recreate it. The active build is unchanged.',
        subject: build.buildId,
      },
    );
  }

  const db = openReadOnly(databasePath);
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: string }>;
    const problems = rows
      .map((row) => row.integrity_check ?? '')
      .filter((value) => value !== '' && value !== 'ok');
    if (problems.length > 0) {
      throw new LoreError(
        'LORE_E_OBJECT_CORRUPT',
        `Build ${build.buildId} failed its integrity check: ${problems.join('; ')}`,
        {
          remediation: 'Run `lore build` to produce a fresh build. The active build is unchanged.',
          subject: build.buildId,
        },
      );
    }
  } finally {
    db.close();
  }
}

export { assertBuildId };
