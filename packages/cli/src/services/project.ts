import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviousBuild } from '@lorepack/compiler';
import { LORE_DIRECTORY, type LoadedConfig } from '@lorepack/core';

/**
 * Reads what the active build recorded, so a plan can compare against it.
 *
 * Opening the state store is deliberately optional: a project that has never been built
 * has no state database, and `lore plan` must work there rather than demanding a build
 * first. That is the case a new user hits.
 */
export interface ProjectState {
  readonly state: { close: () => void } | null;
  readonly previous: PreviousBuild | null;
}

export function readPreviousBuild(config: LoadedConfig): ProjectState {
  const statePath = join(config.projectRoot, LORE_DIRECTORY, 'state.sqlite');
  if (!existsSync(statePath)) return { state: null, previous: null };

  // The build orchestrator (#33) populates this. Until a build exists there is nothing to
  // compare against, and reporting "first build" is the honest answer.
  return { state: null, previous: null };
}
