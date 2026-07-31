import { join } from 'node:path';
import { diffBuilds, renderDiff } from '@lorepack/compiler';
import { type BuildId, LORE_DIRECTORY, LoreError, loadConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { openStateStore, readSnapshot, resolveBuildId } from '../services/builds.js';

export function diffCommand(): CommandDefinition {
  return {
    name: 'diff',
    description: 'Compare two builds. Reads build data only, never the sources.',
    arguments: [
      { name: 'from', description: 'build to compare from', required: false },
      { name: 'to', description: 'build to compare to', required: false },
    ],
    handler: (args, _flags, context): CommandResult => {
      const config = loadConfig({ cwd: context.options.cwd });
      const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);
      const state = openStateStore(loreDirectory);

      try {
        const builds = state.listBuilds();
        const active = state.current();
        const [fromReference, toReference] = args;

        // No arguments compares the previous verified build to the active one; one
        // argument compares that build to the active one. Both are the question a user
        // actually has after a build.
        const to: BuildId =
          toReference !== undefined
            ? resolveBuildId(builds, toReference)
            : (active?.buildId ?? firstOr(builds.at(0)?.buildId));
        const from: BuildId =
          fromReference !== undefined
            ? resolveBuildId(builds, fromReference)
            : toReference !== undefined
              ? (active?.buildId ?? firstOr(builds.at(0)?.buildId))
              : previousOf(
                  builds.map((build) => build.buildId),
                  to,
                );

        const diff = diffBuilds(readSnapshot(loreDirectory, from), readSnapshot(loreDirectory, to));
        return { human: renderDiff(diff), json: diff };
      } finally {
        state.close();
      }
    },
  };
}

function firstOr(buildId: BuildId | undefined): BuildId {
  if (buildId === undefined) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no builds to compare.', {
      remediation: 'Run `lore build` to create one.',
    });
  }
  return buildId;
}

/** History is newest first, so the previous build is the one after the target. */
function previousOf(history: readonly BuildId[], target: BuildId): BuildId {
  const index = history.indexOf(target);
  const previous = index === -1 ? undefined : history[index + 1];
  if (previous === undefined) {
    throw new LoreError(
      'LORE_E_BUILD_NOT_FOUND',
      'There is only one build, so there is nothing to compare it against.',
      { remediation: 'Change a source and run `lore build`, then diff again.' },
    );
  }
  return previous;
}
