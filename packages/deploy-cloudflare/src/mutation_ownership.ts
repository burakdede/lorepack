import { LoreError } from '@lorepack/core';
import type { ProjectionMigrationDatabaseLike } from './projection-migrations.js';

interface MutationOwner {
  readonly token: string;
  readonly kind: string;
  readonly projectId: string | null;
  readonly buildId: string | null;
  readonly startedAt: string;
}

export async function acquireRemoteMutationGuard(
  db: ProjectionMigrationDatabaseLike,
  operation: {
    readonly kind: 'apply' | 'verify' | 'cleanup';
    readonly projectId?: string;
    readonly buildId?: string;
  },
): Promise<{ release(): Promise<void> }> {
  const token = crypto.randomUUID();
  const registration = await db
    .prepare(`INSERT OR IGNORE INTO remote_mutation_guard (id, token, kind, project_id, build_id, started_at)
    VALUES (1, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING token`)
    .bind(token, operation.kind, operation.projectId ?? null, operation.buildId ?? null)
    .run<{ token: string }>();
  if (registration.results?.[0]?.token !== token) {
    const owner = (
      await db
        .prepare(`SELECT token, kind, project_id AS projectId,
      build_id AS buildId, started_at AS startedAt FROM remote_mutation_guard WHERE id = 1`)
        .run<MutationOwner>()
    ).results?.[0];
    throw new LoreError(
      'LORE_E_REMOTE_DEPLOY',
      'A remote mutating operation already owns this catalog.',
      {
        remediation:
          'Wait for that operation to finish. Do not remove ambiguous ownership while it may still be writing.',
        details: { reason: 'remote-mutation-owned', owner: owner ?? null },
      },
    );
  }
  let releasePromise: Promise<void> | undefined;
  return {
    release() {
      releasePromise ??= (async () => {
        const released = await db
          .prepare('DELETE FROM remote_mutation_guard WHERE id = 1 AND token = ? RETURNING token')
          .bind(token)
          .run<{ token: string }>();
        if (released.results?.[0]?.token !== token) {
          throw new LoreError(
            'LORE_E_REMOTE_DEPLOY',
            'Remote mutation ownership could not be released.',
            {
              remediation:
                'Inspect the catalog operation owner before resuming deployment or cleanup.',
              details: { reason: 'remote-mutation-owner-lost' },
            },
          );
        }
      })();
      return releasePromise;
    },
  };
}

export function remoteMutationCompletionUnknown(cause: unknown): LoreError {
  return new LoreError('LORE_E_REMOTE_DEPLOY', 'Remote mutation completion is unknown.', {
    remediation:
      'Inspect the operation owner and remote state before retrying. Preserve ownership while an earlier write may still be running.',
    details: { reason: 'remote-mutation-completion-unknown' },
    cause,
  });
}

export function hasUnknownRemoteMutationCompletion(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    if (
      current instanceof LoreError &&
      current.details?.reason === 'remote-mutation-completion-unknown'
    )
      return true;
    if (current instanceof Error) pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}
