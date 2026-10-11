import { LoreError, type RuntimeIdentity, runtimeIdentitySchema } from '@lorepack/core/worker';
import type { D1DatabaseLike } from './storage.js';

interface RuntimeIdentityRow extends RuntimeIdentity {
  readonly projectId: string;
}

export const RUNTIME_IDENTITY_QUERY =
  'SELECT project_id AS projectId, corpus_id AS corpusId, namespace_id AS namespaceId FROM runtime_identity WHERE id = 1';

export function checkedRuntimeIdentity(
  row: RuntimeIdentityRow | null,
  projectId: string,
  corpusId?: string,
): RuntimeIdentity {
  if (row === null) {
    throw new LoreError(
      'LORE_E_SCHEMA_MISMATCH',
      'This deployment has no runtime identity binding.',
      {
        remediation: 'Deploy the local corpus with this version before serving it.',
      },
    );
  }
  const identity = runtimeIdentitySchema.safeParse({
    corpusId: row.corpusId,
    namespaceId: row.namespaceId,
  });
  if (!identity.success) {
    throw new LoreError(
      'LORE_E_SCHEMA_MISMATCH',
      'This deployment has an invalid runtime identity binding.',
      {
        remediation: 'Restore the deployment state from a known-good backup.',
      },
    );
  }
  if (
    row.projectId !== projectId ||
    (corpusId !== undefined && identity.data.corpusId !== corpusId)
  ) {
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      'The deployment belongs to another project or corpus.',
      {
        remediation:
          'Use the deployment configured for this corpus. A content digest does not grant access.',
      },
    );
  }
  return identity.data;
}

export async function readRuntimeIdentity(
  db: D1DatabaseLike,
  projectId: string,
  corpusId?: string,
): Promise<RuntimeIdentity> {
  let row: RuntimeIdentityRow | null;
  try {
    row = await db.prepare(RUNTIME_IDENTITY_QUERY).first<RuntimeIdentityRow>();
  } catch (cause) {
    throw new LoreError(
      'LORE_E_SCHEMA_MISMATCH',
      'The deployment runtime identity could not be read.',
      {
        remediation:
          'Deploy the local corpus with this version, or restore damaged deployment state.',
        cause,
      },
    );
  }
  return checkedRuntimeIdentity(row, projectId, corpusId);
}
