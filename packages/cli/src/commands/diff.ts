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

        // No arguments compares the active build against its neighbour in history; one
        // argument compares that build to the active one. Both are the question a user
        // actually has.
        const history = builds.map((build) => build.buildId);
        const { from, to } =
          fromReference === undefined && toReference === undefined
            ? neighbourOf(history, active?.buildId ?? firstOr(history.at(0)))
            : {
                to:
                  toReference !== undefined
                    ? resolveBuildId(builds, toReference)
                    : (active?.buildId ?? firstOr(history.at(0))),
                from:
                  fromReference !== undefined
                    ? resolveBuildId(builds, fromReference)
                    : (active?.buildId ?? firstOr(history.at(0))),
              };

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

/**
 * The pair a bare `lore diff` compares: the active build and the build beside it.
 *
 * History is newest first, so ordinarily that is the build after the target, and the diff
 * reads "what the last build changed". After a rollback the active build is the oldest, and
 * there is nothing after it. That used to be reported as "there is only one build", which
 * `lore builds` contradicted on the line above (#176), and the suggested fix was to change
 * a source when the build the user wanted already existed.
 *
 * So it looks the other way instead, and the diff reads "what moving forward would change".
 * Both directions answer the same question, which is what the neighbouring build differs by,
 * and the rendering names both ids so the direction is never guessed.
 */
function neighbourOf(history: readonly BuildId[], target: BuildId): { from: BuildId; to: BuildId } {
  const index = history.indexOf(target);
  const older = index === -1 ? undefined : history[index + 1];
  if (older !== undefined) return { from: older, to: target };

  const newer = index <= 0 ? undefined : history[index - 1];
  if (newer !== undefined) return { from: target, to: newer };

  throw new LoreError(
    'LORE_E_BUILD_NOT_FOUND',
    'There is only one build, so there is nothing to compare it against.',
    { remediation: 'Change a source and run `lore build`, then diff again.' },
  );
}
