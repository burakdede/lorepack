import { assertBuildId, type BuildId } from '@lorepack/core';
import type { ProjectionMigrationDatabaseLike } from './projection-migrations.js';
import { r2ArchiveKey, r2ObjectKey } from './r2-keys.js';

interface ActiveBuildRow {
  readonly buildId: string | null;
}

interface ProjectedBuildRow {
  readonly buildId: string;
  readonly projectedAt: string;
  readonly verifiedAt: string | null;
}

interface ObjectHashRow {
  readonly objectHash: string;
}

export interface RemoteRetentionPlan {
  readonly activeBuildId: BuildId | null;
  readonly keep: readonly BuildId[];
  readonly remove: readonly BuildId[];
  readonly archiveKeysToRemove: readonly string[];
  readonly objectKeysToRemove: readonly string[];
}

export async function planRemoteRetention(
  db: ProjectionMigrationDatabaseLike,
  projectId: string,
  keepPrevious: number,
): Promise<RemoteRetentionPlan> {
  const active = await db
    .prepare('SELECT build_id AS buildId FROM active_build WHERE id = 1')
    .run<ActiveBuildRow>();
  const activeBuildId =
    active.results?.[0]?.buildId === null || active.results?.[0]?.buildId === undefined
      ? null
      : assertBuildId(active.results[0].buildId);

  const projected = await db
    .prepare(
      `SELECT build_id AS buildId, projected_at AS projectedAt, verified_at AS verifiedAt
FROM projected_builds
WHERE project_id = ?
ORDER BY projected_at DESC, build_id DESC`,
    )
    .bind(projectId)
    .run<ProjectedBuildRow>();
  const rows = projected.results ?? [];

  const keep = new Set<BuildId>();
  if (activeBuildId !== null) keep.add(activeBuildId);

  const verified = [...rows]
    .filter((row) => row.verifiedAt !== null)
    .sort((left, right) =>
      left.verifiedAt === right.verifiedAt
        ? left.projectedAt === right.projectedAt
          ? right.buildId.localeCompare(left.buildId)
          : right.projectedAt.localeCompare(left.projectedAt)
        : (right.verifiedAt as string).localeCompare(left.verifiedAt as string),
    );
  const keepTarget = keepPrevious + (activeBuildId === null ? 0 : 1);
  for (const row of verified) {
    if (keep.size >= keepTarget) break;
    keep.add(assertBuildId(row.buildId));
  }

  const remove = rows
    .map((row) => assertBuildId(row.buildId))
    .filter((buildId) => !keep.has(buildId));

  const retainedObjectHashes = await readObjectHashes(db, projectId, [...keep]);
  const removedObjectHashes = await readObjectHashes(db, projectId, remove);
  const doomedObjectKeys = [...removedObjectHashes]
    .filter((hash) => !retainedObjectHashes.has(hash))
    .sort()
    .map((hash) => r2ObjectKey(projectId, hash));

  return {
    activeBuildId,
    keep: [...keep],
    remove,
    archiveKeysToRemove: remove.map((buildId) => r2ArchiveKey(projectId, buildId)),
    objectKeysToRemove: doomedObjectKeys,
  };
}

async function readObjectHashes(
  db: ProjectionMigrationDatabaseLike,
  projectId: string,
  buildIds: readonly BuildId[],
): Promise<ReadonlySet<string>> {
  if (buildIds.length === 0) return new Set();

  const placeholders = buildIds.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT DISTINCT object_hash AS objectHash
FROM artifacts
WHERE project_id = ? AND build_id IN (${placeholders})
ORDER BY object_hash`,
    )
    .bind(projectId, ...buildIds)
    .run<ObjectHashRow>();
  return new Set((rows.results ?? []).map((row) => row.objectHash));
}
