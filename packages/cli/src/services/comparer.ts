import { join } from 'node:path';
import { diffBuilds } from '@lorepack/compiler';
import { type BuildComparer, LORE_DIRECTORY, LoreError } from '@lorepack/core';
import { openStateStore, readSnapshot, resolveBuildId } from './builds.js';

/**
 * The local build comparer, which is what makes `lore://build/{a}/diff/{b}` answerable.
 *
 * A diff is not a runtime capability: it reads two builds, neither of which need be the
 * active one, so it cannot go through the seven-capability boundary that reads exactly one
 * build through one handle. It is a separate port, and this is the local adapter for it.
 *
 * Every read is of build records alone, never of the sources, so the comparison is instant
 * and still possible after the source directory is gone (architecture 15.6). State is
 * opened and closed per comparison rather than held: a server may sit idle for hours
 * between diffs, and a long-lived handle on the state database is a lock nobody is using.
 */
export function createLocalComparer(projectRoot: string): BuildComparer {
  const loreDirectory = join(projectRoot, LORE_DIRECTORY);

  return {
    async compare(fromBuildId, toBuildId) {
      const state = openStateStore(loreDirectory);
      try {
        const builds = state.listBuilds();
        // Resolved through history, so a prefix works and an id this project never built is
        // refused by name instead of read as a missing directory.
        const from = resolveBuildId(builds, requireId(fromBuildId, 'from'));
        const to = resolveBuildId(builds, requireId(toBuildId, 'to'));
        return diffBuilds(readSnapshot(loreDirectory, from), readSnapshot(loreDirectory, to));
      } finally {
        state.close();
      }
    },
  };
}

function requireId(value: string, position: 'from' | 'to'): string {
  if (value.trim() !== '') return value;
  throw new LoreError('LORE_E_INVALID_ARGUMENT', `The ${position} build id is empty.`, {
    remediation: 'Address the resource as lore://build/{buildId}/diff/{otherBuildId}.',
  });
}
