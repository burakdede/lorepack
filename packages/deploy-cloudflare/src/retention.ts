import { assertBuildId, type BuildId } from '@lorepack/core';
import type { ProjectionMigrationDatabaseLike } from './projection-migrations.js';
import { r2ArchiveKey, r2ObjectKey } from './r2-keys.js';
import type { R2BucketLike } from './storage.js';

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

export interface RemoteRetentionApplyResult extends RemoteRetentionPlan {
  readonly d1: {
    readonly projectedBuildsRemoved: number;
    readonly buildManifestsRemoved: number;
    readonly buildWarningsRemoved: number;
    readonly artifactsRemoved: number;
    readonly supersessionsRemoved: number;
    readonly nodesRemoved: number;
    readonly chunksRemoved: number;
    readonly ftsRowsRemoved: number;
    readonly projectedTablesRemoved: number;
    readonly projectedTableColumnsRemoved: number;
    readonly physicalTablesDropped: readonly string[];
  };
  readonly r2: {
    readonly archiveKeysRemoved: readonly string[];
    readonly objectKeysRemoved: readonly string[];
  };
}

export interface RemoteRetentionResumeState {
  readonly d1Completed: boolean;
  readonly archivesCompleted: boolean;
  readonly objectsCompleted: boolean;
  readonly d1: RemoteRetentionApplyResult['d1'];
  readonly archiveKeysRemoved: readonly string[];
  readonly objectKeysRemoved: readonly string[];
}

export class RemoteRetentionApplyError extends Error {
  readonly progress: RemoteRetentionResumeState;
  override readonly cause: unknown;

  constructor(message: string, progress: RemoteRetentionResumeState, cause: unknown) {
    super(message);
    this.name = 'RemoteRetentionApplyError';
    this.progress = progress;
    this.cause = cause;
  }
}

interface MutableD1RetentionReport {
  projectedBuildsRemoved: number;
  buildManifestsRemoved: number;
  buildWarningsRemoved: number;
  artifactsRemoved: number;
  supersessionsRemoved: number;
  nodesRemoved: number;
  chunksRemoved: number;
  ftsRowsRemoved: number;
  projectedTablesRemoved: number;
  projectedTableColumnsRemoved: number;
  physicalTablesDropped: string[];
}

interface SqlNameRow {
  readonly sqlName: string;
}

interface CountRow {
  readonly count: number;
}

const DELETE_PROJECTED_BUILD = 'DELETE FROM projected_builds WHERE project_id = ? AND build_id = ?';
const DELETE_MANIFEST = 'DELETE FROM build_manifests WHERE project_id = ? AND build_id = ?';
const DELETE_WARNINGS = 'DELETE FROM build_warnings WHERE project_id = ? AND build_id = ?';
const DELETE_ARTIFACTS = 'DELETE FROM artifacts WHERE project_id = ? AND build_id = ?';
const DELETE_SUPERSESSIONS = 'DELETE FROM supersessions WHERE project_id = ? AND build_id = ?';
const DELETE_NODES = 'DELETE FROM nodes WHERE project_id = ? AND build_id = ?';
const DELETE_CHUNKS = 'DELETE FROM chunks WHERE project_id = ? AND build_id = ?';
const DELETE_FTS = 'DELETE FROM chunks_fts WHERE project_id = ? AND build_id = ?';
const DELETE_PROJECTED_COLUMNS = 'DELETE FROM table_columns WHERE project_id = ? AND build_id = ?';
const DELETE_PROJECTED_TABLES = 'DELETE FROM tables WHERE project_id = ? AND build_id = ?';
const LOOKUP_PROJECTED_SQL_NAMES = `SELECT sql_name AS sqlName
FROM tables
WHERE project_id = ? AND build_id = ?
ORDER BY sql_name`;

export async function planRemoteRetention(
  db: ProjectionMigrationDatabaseLike,
  projectId: string,
  keepPrevious: number,
): Promise<RemoteRetentionPlan> {
  if (!(await hasProjectedBuildsTable(db))) {
    return {
      activeBuildId: null,
      keep: [],
      remove: [],
      archiveKeysToRemove: [],
      objectKeysToRemove: [],
    };
  }

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

export async function applyRemoteRetention(
  db: ProjectionMigrationDatabaseLike,
  bucket: R2BucketLike,
  projectId: string,
  keepPrevious: number,
): Promise<RemoteRetentionApplyResult> {
  const plan = await planRemoteRetention(db, projectId, keepPrevious);
  return await applyRemoteRetentionPlan(db, bucket, plan);
}

export async function applyRemoteRetentionPlan(
  db: ProjectionMigrationDatabaseLike,
  bucket: R2BucketLike,
  plan: RemoteRetentionPlan,
  resume?: RemoteRetentionResumeState,
): Promise<RemoteRetentionApplyResult> {
  if (plan.remove.length === 0) {
    return {
      ...plan,
      d1: emptyD1Report(),
      r2: { archiveKeysRemoved: [], objectKeysRemoved: [] },
    };
  }

  const progress = cloneResumeState(resume);

  try {
    if (!progress.d1Completed) {
      progress.d1 = await deleteProjectedBuildsFromD1(db, projectIdForPlan(plan), plan.remove);
      progress.d1Completed = true;
    }
    if (!progress.archivesCompleted) {
      progress.archiveKeysRemoved = await deletePlannedR2Keys(
        bucket,
        plan.archiveKeysToRemove,
        progress.archiveKeysRemoved,
      );
      progress.archivesCompleted = true;
    }
    if (!progress.objectsCompleted) {
      progress.objectKeysRemoved = await deletePlannedR2Keys(
        bucket,
        plan.objectKeysToRemove,
        progress.objectKeysRemoved,
      );
      progress.objectsCompleted = true;
    }
  } catch (cause) {
    throw new RemoteRetentionApplyError(
      `The cloudflare target failed while cleaning up ${plan.remove.length} remote build${plan.remove.length === 1 ? '' : 's'}.`,
      progress,
      cause,
    );
  }

  return {
    ...plan,
    d1: progress.d1,
    r2: {
      archiveKeysRemoved: progress.archiveKeysRemoved,
      objectKeysRemoved: progress.objectKeysRemoved,
    },
  };
}

async function hasProjectedBuildsTable(db: ProjectionMigrationDatabaseLike): Promise<boolean> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projected_builds'")
    .run<{ name: string }>();
  return (rows.results?.length ?? 0) > 0;
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

async function deleteProjectedBuildsFromD1(
  db: ProjectionMigrationDatabaseLike,
  projectId: string,
  buildIds: readonly BuildId[],
): Promise<MutableD1RetentionReport> {
  const deleted: MutableD1RetentionReport = emptyD1Report();

  try {
    await db.prepare('BEGIN IMMEDIATE').run();
    for (const buildId of buildIds) {
      const sqlNames = await db
        .prepare(LOOKUP_PROJECTED_SQL_NAMES)
        .bind(projectId, buildId)
        .run<SqlNameRow>();
      for (const row of sqlNames.results ?? []) {
        await db.prepare(`DROP TABLE IF EXISTS ${row.sqlName}`).run();
        deleted.physicalTablesDropped.push(row.sqlName);
      }

      deleted.projectedTableColumnsRemoved += await deleteRows(
        db,
        'table_columns',
        DELETE_PROJECTED_COLUMNS,
        projectId,
        buildId,
      );
      deleted.projectedTablesRemoved += await deleteRows(
        db,
        'tables',
        DELETE_PROJECTED_TABLES,
        projectId,
        buildId,
      );
      deleted.ftsRowsRemoved += await deleteRows(db, 'chunks_fts', DELETE_FTS, projectId, buildId);
      deleted.chunksRemoved += await deleteRows(db, 'chunks', DELETE_CHUNKS, projectId, buildId);
      deleted.nodesRemoved += await deleteRows(db, 'nodes', DELETE_NODES, projectId, buildId);
      deleted.supersessionsRemoved += await deleteRows(
        db,
        'supersessions',
        DELETE_SUPERSESSIONS,
        projectId,
        buildId,
      );
      deleted.artifactsRemoved += await deleteRows(
        db,
        'artifacts',
        DELETE_ARTIFACTS,
        projectId,
        buildId,
      );
      deleted.buildWarningsRemoved += await deleteRows(
        db,
        'build_warnings',
        DELETE_WARNINGS,
        projectId,
        buildId,
      );
      deleted.buildManifestsRemoved += await deleteRows(
        db,
        'build_manifests',
        DELETE_MANIFEST,
        projectId,
        buildId,
      );
      deleted.projectedBuildsRemoved += await deleteRows(
        db,
        'projected_builds',
        DELETE_PROJECTED_BUILD,
        projectId,
        buildId,
      );
    }
    await db.prepare('COMMIT').run();
    return deleted;
  } catch (cause) {
    try {
      await db.prepare('ROLLBACK').run();
    } catch {}
    throw cause;
  }
}

async function deleteRows(
  db: ProjectionMigrationDatabaseLike,
  table: string,
  deleteStatement: string,
  projectId: string,
  buildId: BuildId,
): Promise<number> {
  const rows = await db
    .prepare(`SELECT count(*) AS count FROM ${table} WHERE project_id = ? AND build_id = ?`)
    .bind(projectId, buildId)
    .run<CountRow>();
  const count = Number(rows.results?.[0]?.count ?? 0);
  if (count === 0) return 0;
  await db.prepare(deleteStatement).bind(projectId, buildId).run();
  return count;
}

async function deletePlannedR2Keys(
  bucket: R2BucketLike,
  keys: readonly string[],
  alreadyRemoved: readonly string[],
): Promise<string[]> {
  if (bucket.delete === undefined) {
    throw new Error('The configured R2 bucket adapter cannot delete objects.');
  }

  const removed = [...alreadyRemoved];
  const seen = new Set(removed);
  for (const key of keys) {
    if (seen.has(key)) continue;
    if ((await bucket.head(key)) === null) continue;
    await bucket.delete(key);
    removed.push(key);
    seen.add(key);
  }
  return removed;
}

function emptyD1Report(): MutableD1RetentionReport {
  return {
    projectedBuildsRemoved: 0,
    buildManifestsRemoved: 0,
    buildWarningsRemoved: 0,
    artifactsRemoved: 0,
    supersessionsRemoved: 0,
    nodesRemoved: 0,
    chunksRemoved: 0,
    ftsRowsRemoved: 0,
    projectedTablesRemoved: 0,
    projectedTableColumnsRemoved: 0,
    physicalTablesDropped: [],
  };
}

function cloneResumeState(resume?: RemoteRetentionResumeState): {
  d1Completed: boolean;
  archivesCompleted: boolean;
  objectsCompleted: boolean;
  d1: MutableD1RetentionReport;
  archiveKeysRemoved: string[];
  objectKeysRemoved: string[];
} {
  return {
    d1Completed: resume?.d1Completed === true,
    archivesCompleted: resume?.archivesCompleted === true,
    objectsCompleted: resume?.objectsCompleted === true,
    d1: {
      ...emptyD1Report(),
      ...(resume?.d1 === undefined
        ? {}
        : {
            ...resume.d1,
            physicalTablesDropped: [...resume.d1.physicalTablesDropped],
          }),
    },
    archiveKeysRemoved: [...(resume?.archiveKeysRemoved ?? [])],
    objectKeysRemoved: [...(resume?.objectKeysRemoved ?? [])],
  };
}

function projectIdForPlan(plan: RemoteRetentionPlan): string {
  const firstArchiveKey = plan.archiveKeysToRemove[0];
  if (firstArchiveKey !== undefined) return firstArchiveKey.slice(0, firstArchiveKey.indexOf('/'));

  const firstObjectKey = plan.objectKeysToRemove[0];
  if (firstObjectKey !== undefined) return firstObjectKey.slice(0, firstObjectKey.indexOf('/'));

  throw new Error('A non-empty remote retention plan did not include any project-scoped keys.');
}
