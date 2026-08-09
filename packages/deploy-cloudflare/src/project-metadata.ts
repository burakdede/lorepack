import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type BuildWarning,
  buildManifestSchema,
  buildWarningSchema,
  LoreError,
} from '@lorepack/core';
import type { ProjectionMigrationDatabaseLike } from './projection-migrations.js';
import { PROJECTION_SCHEMA_VERSION } from './projection-schema.js';
import {
  createProjectionWriteState,
  type ProjectionWriteOptions,
  projectionWriteOptions,
  runProjectionBatch,
} from './projection-write.js';

interface BuildArtifactRow {
  readonly id: string;
  readonly source_id: string;
  readonly relative_path: string;
  readonly display_path: string;
  readonly media_type: string;
  readonly byte_size: number;
  readonly content_hash: string;
  readonly parser_id: string;
  readonly parser_version: string;
  readonly title: string | null;
  readonly status: string;
  readonly authority: number;
  readonly object_hash: string;
  readonly metadata: string;
}

interface SupersessionRow {
  readonly artifact_id: string;
  readonly superseded_id: string;
}

export interface ProjectBuildMetadataOptions {
  readonly db: ProjectionMigrationDatabaseLike;
  readonly projectId: string;
  readonly buildDirectory: string;
  readonly projectedAt?: string;
  readonly retryAttempts?: number;
  readonly retryDelayMs?: number;
  readonly progressIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onProgress?: ProjectionWriteOptions['onProgress'];
}

export interface ProjectBuildMetadataResult {
  readonly buildId: string;
  readonly projectedArtifacts: number;
  readonly projectedWarnings: number;
  readonly projectedSupersessions: number;
}

const DELETE_PROJECTED_BUILD = 'DELETE FROM projected_builds WHERE project_id = ? AND build_id = ?';
const DELETE_MANIFEST = 'DELETE FROM build_manifests WHERE project_id = ? AND build_id = ?';
const DELETE_WARNINGS = 'DELETE FROM build_warnings WHERE project_id = ? AND build_id = ?';
const DELETE_ARTIFACTS = 'DELETE FROM artifacts WHERE project_id = ? AND build_id = ?';
const DELETE_SUPERSESSIONS = 'DELETE FROM supersessions WHERE project_id = ? AND build_id = ?';

const UPSERT_PROJECTED_BUILD = `INSERT OR REPLACE INTO projected_builds
  (project_id, build_id, build_schema_version, compiler_version, projection_schema_version, projected_at)
VALUES (?, ?, ?, ?, ?, ?)`;

const UPSERT_MANIFEST = `INSERT OR REPLACE INTO build_manifests
  (project_id, build_id, manifest_json)
VALUES (?, ?, ?)`;

const INSERT_WARNING = `INSERT INTO build_warnings
  (project_id, build_id, code, class, path, message)
VALUES (?, ?, ?, ?, ?, ?)`;

const INSERT_ARTIFACT = `INSERT INTO artifacts
  (id, project_id, build_id, source_id, relative_path, display_path, media_type, byte_size,
   content_hash, parser_id, parser_version, title, status, authority, object_hash, metadata_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_SUPERSESSION = `INSERT INTO supersessions
  (project_id, build_id, artifact_id, superseded_id)
VALUES (?, ?, ?, ?)`;

const BUILD_ARTIFACTS_QUERY = `SELECT id, source_id, relative_path, display_path, media_type, byte_size,
       content_hash, parser_id, parser_version, title, status, authority, object_hash, metadata
FROM artifacts
ORDER BY id`;

const BUILD_SUPERSESSIONS_QUERY = `SELECT artifact_id, superseded_id
FROM supersessions
ORDER BY artifact_id, superseded_id`;

export async function projectBuildMetadata(
  options: ProjectBuildMetadataOptions,
): Promise<ProjectBuildMetadataResult> {
  const writeOptions = projectionWriteOptions(options);
  const manifest = readManifest(options.buildDirectory);
  const warnings = readWarnings(options.buildDirectory, manifest.warnings);
  const projectedAt = options.projectedAt ?? new Date().toISOString();
  const buildDatabase = openBuildDatabase(options.buildDirectory);

  try {
    const artifacts = buildDatabase
      .prepare(BUILD_ARTIFACTS_QUERY)
      .all() as unknown as BuildArtifactRow[];
    const supersessions = buildDatabase
      .prepare(BUILD_SUPERSESSIONS_QUERY)
      .all() as unknown as SupersessionRow[];
    const progress = createProjectionWriteState(
      5 + 2 + warnings.length + artifacts.length + supersessions.length,
    );

    await options.db.prepare('BEGIN IMMEDIATE').run();
    try {
      await deleteNamespace(
        options.db,
        options.projectId,
        manifest.buildId,
        writeOptions,
        progress,
      );

      await runProjectionBatch(
        options.db,
        UPSERT_PROJECTED_BUILD,
        [
          options.projectId,
          manifest.buildId,
          manifest.schemaVersion,
          manifest.compilerVersion,
          PROJECTION_SCHEMA_VERSION,
          projectedAt,
        ],
        writeOptions,
        progress,
        'upsert projected build metadata',
      );

      await runProjectionBatch(
        options.db,
        UPSERT_MANIFEST,
        [options.projectId, manifest.buildId, JSON.stringify(manifest)],
        writeOptions,
        progress,
        'upsert build manifest',
      );

      for (const warning of warnings) {
        await runProjectionBatch(
          options.db,
          INSERT_WARNING,
          [
            options.projectId,
            manifest.buildId,
            warning.code,
            warning.class,
            warning.path ?? null,
            warning.message,
          ],
          writeOptions,
          progress,
          `insert warning ${warning.code}`,
        );
      }

      for (const artifact of artifacts) {
        await runProjectionBatch(
          options.db,
          INSERT_ARTIFACT,
          [
            artifact.id,
            options.projectId,
            manifest.buildId,
            artifact.source_id,
            artifact.relative_path,
            artifact.display_path,
            artifact.media_type,
            artifact.byte_size,
            artifact.content_hash,
            artifact.parser_id,
            artifact.parser_version,
            artifact.title,
            artifact.status,
            artifact.authority,
            artifact.object_hash,
            artifact.metadata,
          ],
          writeOptions,
          progress,
          `insert artifact ${artifact.id}`,
        );
      }

      for (const supersession of supersessions) {
        await runProjectionBatch(
          options.db,
          INSERT_SUPERSESSION,
          [
            options.projectId,
            manifest.buildId,
            supersession.artifact_id,
            supersession.superseded_id,
          ],
          writeOptions,
          progress,
          `insert supersession ${supersession.artifact_id}`,
        );
      }

      await options.db.prepare('COMMIT').run();
    } catch (cause) {
      await options.db.prepare('ROLLBACK').run();
      throw cause;
    }

    return {
      buildId: manifest.buildId,
      projectedArtifacts: artifacts.length,
      projectedWarnings: warnings.length,
      projectedSupersessions: supersessions.length,
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
        remediation: 'Project only a verified sealed build directory.',
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

function readManifest(buildDirectory: string) {
  const path = join(buildDirectory, 'manifest.json');
  if (!existsSync(path)) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `Build ${buildDirectory} has no manifest.`, {
      remediation: 'Project only a verified sealed build directory.',
      subject: path,
    });
  }
  return buildManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function readWarnings(
  buildDirectory: string,
  fallback: readonly BuildWarning[],
): readonly BuildWarning[] {
  const path = join(buildDirectory, 'reports', 'warnings.json');
  if (!existsSync(path)) return fallback;
  return buildWarningSchema.array().parse(JSON.parse(readFileSync(path, 'utf8')));
}

async function deleteNamespace(
  db: ProjectionMigrationDatabaseLike,
  projectId: string,
  buildId: string,
  options: ProjectionWriteOptions,
  progress: ReturnType<typeof createProjectionWriteState>,
): Promise<void> {
  for (const [statement, detail] of [
    [DELETE_SUPERSESSIONS, 'delete projected supersessions'],
    [DELETE_ARTIFACTS, 'delete projected artifacts'],
    [DELETE_WARNINGS, 'delete projected warnings'],
    [DELETE_MANIFEST, 'delete projected manifest'],
    [DELETE_PROJECTED_BUILD, 'delete projected build metadata'],
  ] as const) {
    await runProjectionBatch(db, statement, [projectId, buildId], options, progress, detail);
  }
}
