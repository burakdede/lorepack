import { LoreError, SCHEMA_VERSION } from '@lorepack/core/worker';
import { PROJECTION_SCHEMA_VERSION } from './projection-schema.js';

export interface ProjectionStateStatementLike {
  bind(...values: unknown[]): ProjectionStateStatementLike;
  run<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }>;
}

export interface ProjectionStateDatabaseLike {
  prepare(query: string): ProjectionStateStatementLike;
}

export interface ProjectionNamespace {
  readonly projectId: string;
  readonly buildId: string;
}

interface ProjectionStateRow {
  readonly buildSchemaVersion: number;
  readonly projectionSchemaVersion: number;
}

const PROJECTION_STATE_QUERY = `SELECT build_schema_version AS buildSchemaVersion,
       projection_schema_version AS projectionSchemaVersion
FROM projected_builds
WHERE project_id = ? AND build_id = ?
LIMIT 1`;

export async function assertProjectionReadable(
  db: ProjectionStateDatabaseLike,
  namespace: ProjectionNamespace,
): Promise<void> {
  const row = (
    await db
      .prepare(PROJECTION_STATE_QUERY)
      .bind(namespace.projectId, namespace.buildId)
      .run<ProjectionStateRow>()
  ).results?.[0];

  if (row === undefined) {
    throw new LoreError(
      'LORE_E_BUILD_NOT_FOUND',
      `Projected build ${namespace.buildId.slice(0, 17)} is missing its projection metadata.`,
      {
        remediation: 'Project the build again before serving it from the Worker.',
        subject: namespace.buildId,
      },
    );
  }

  assertSchema(
    'catalog schema',
    namespace.buildId,
    Number(row.buildSchemaVersion),
    SCHEMA_VERSION,
    'Run `lore build` again, then re-project this build. A sealed build is never migrated in place.',
    'This build was written by a newer Lorepack than the Worker runtime understands. Upgrade Lorepack or re-project with this version.',
  );
  assertSchema(
    'projection schema',
    namespace.buildId,
    Number(row.projectionSchemaVersion),
    PROJECTION_SCHEMA_VERSION,
    'Project the build again with this Lorepack version so the Worker sees the current D1 projection shape.',
    'This projected build was written by a newer Lorepack than this Worker runtime understands. Upgrade Lorepack or project it again with this version.',
  );
}

function assertSchema(
  label: string,
  buildId: string,
  actual: number,
  expected: number,
  olderRemediation: string,
  newerRemediation: string,
): void {
  if (actual === expected) return;
  const older = actual < expected;
  throw new LoreError(
    'LORE_E_SCHEMA_MISMATCH',
    `Build ${buildId.slice(0, 17)} was written at ${label} ${actual}, and this Worker reads ${expected}.`,
    {
      remediation: older ? olderRemediation : newerRemediation,
      subject: buildId,
      details: { expected, actual, label },
    },
  );
}
