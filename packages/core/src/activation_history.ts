import { LoreError } from './errors/lore-error.js';
import type { BuildId } from './hash/id.js';
import type { ActivationEvent } from './ports/storage.js';

export function previousActivation(
  active: { readonly buildId: BuildId; readonly generation: number } | null,
  latest: ActivationEvent | undefined,
): BuildId {
  if (active === null || latest === undefined) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'No previous activation is recorded.', {
      remediation: 'Select a retained build ID explicitly after inspecting the build history.',
    });
  }
  if (latest.buildId !== active.buildId || latest.generation > active.generation) {
    throw new LoreError(
      'LORE_E_SCHEMA_MISMATCH',
      'Activation history does not match the active pointer.',
      {
        remediation: 'Restore consistent project state before changing the active build.',
      },
    );
  }
  if (latest.kind === 'baseline') {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'No previous activation is recorded.', {
      remediation: 'Select a retained build ID explicitly. Earlier activation history is unknown.',
    });
  }
  if (latest.previousBuildId === null) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'No previous activation is recorded.', {
      remediation: 'This is the first recorded activation. Select a retained build ID explicitly.',
    });
  }
  return latest.previousBuildId;
}
