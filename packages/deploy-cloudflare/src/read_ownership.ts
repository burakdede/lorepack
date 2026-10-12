import { type BuildId, LoreError, type RuntimeIdentity } from '@lorepack/core/worker';

interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface Database {
  prepare(query: string): Statement;
}

interface OwnershipRow extends RuntimeIdentity {
  readonly token: string;
  readonly projectId: string;
  readonly buildId: string;
  readonly generation: number;
}

export const REMOTE_READ_LIFETIME_SECONDS = 300;

export async function acquireReadOwnership(
  db: Database,
  projectId: string,
  selectedBuildId?: BuildId,
): Promise<(OwnershipRow & { release(): Promise<void> }) | null> {
  const token = crypto.randomUUID();
  let owned: OwnershipRow | null;
  try {
    owned = await db
      .prepare(`INSERT INTO runtime_read_owners
      (token, project_id, build_id, expires_at, checked_at)
    SELECT ?, b.project_id, b.build_id, unixepoch('now') + ?, unixepoch('now')
    FROM projected_builds b JOIN active_build a ON a.id = 1
      JOIN runtime_identity i ON i.id = 1
    WHERE b.project_id = ? AND b.build_id = COALESCE(?, a.build_id)
      AND (? IS NULL OR b.verified_at IS NOT NULL)
      AND i.project_id = b.project_id
      AND NOT EXISTS (SELECT 1 FROM retention_claims c
        WHERE c.project_id = b.project_id AND c.build_id = b.build_id)
    RETURNING token, project_id AS projectId, build_id AS buildId,
      (SELECT generation FROM active_build WHERE id = 1) AS generation,
      (SELECT corpus_id FROM runtime_identity WHERE id = 1) AS corpusId,
      (SELECT namespace_id FROM runtime_identity WHERE id = 1) AS namespaceId`)
      .bind(
        token,
        REMOTE_READ_LIFETIME_SECONDS,
        projectId,
        selectedBuildId ?? null,
        selectedBuildId ?? null,
      )
      .first<OwnershipRow>();
  } catch (cause) {
    throw new LoreError(
      'LORE_E_SCHEMA_MISMATCH',
      'Remote read ownership could not be registered.',
      {
        remediation:
          'Deploy with this version to migrate operational ownership state before reading.',
        subject: selectedBuildId ?? projectId,
        cause,
      },
    );
  }
  if (owned === null) return null;
  if (owned.token !== token)
    throw new LoreError(
      'LORE_E_SCHEMA_MISMATCH',
      'Remote ownership registration returned an invalid capability.',
      {
        remediation: 'Restore this deployment with the supported D1 ownership schema.',
      },
    );
  const buildId = owned.buildId;
  let releasePromise: Promise<void> | undefined;
  return {
    ...owned,
    release() {
      releasePromise ??= (async () => {
        const released = await db
          .prepare(`DELETE FROM runtime_read_owners WHERE token = ?
          RETURNING token, expires_at > unixepoch('now') AS live`)
          .bind(token)
          .first<{ token: string; live: number }>();
        if (released?.token !== token || Number(released.live) !== 1) {
          throw new LoreError(
            'LORE_E_LIMIT_EXCEEDED',
            'The remote read ownership expired before the read completed.',
            {
              remediation:
                'Retry the read against retained evidence. Remote reads must complete within five minutes.',
              subject: buildId,
              details: {
                reason: 'remote-read-expired',
                lifetimeSeconds: REMOTE_READ_LIFETIME_SECONDS,
              },
            },
          );
        }
      })();
      return releasePromise;
    },
  };
}
