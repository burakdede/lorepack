import { join } from 'node:path';
import { ProjectLock } from '@lorepack/backend-local';
import { count, LORE_DIRECTORY, LoreError, loadConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { openStateStore } from '../services/builds.js';
import {
  applyRetention,
  DEFAULT_KEEP_PREVIOUS,
  planRetention,
  renderRetentionPlan,
} from '../services/retention.js';

export function pruneCommand(): CommandDefinition {
  return {
    name: 'prune',
    description: 'Remove old builds, keeping the active one and the previous five.',
    flags: [
      {
        flags: '--keep <count>',
        description: `previous builds to keep (default ${DEFAULT_KEEP_PREVIOUS})`,
      },
      { flags: '--yes', description: 'apply the plan instead of only printing it' },
    ],
    handler: async (_args, flags, context): Promise<CommandResult> => {
      const config = loadConfig({ cwd: context.options.cwd });
      const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);
      const state = openStateStore(loreDirectory);

      try {
        const keep = parseKeep(flags.keep);
        const plan = planRetention(
          loreDirectory,
          state.listBuilds(),
          state.current()?.buildId ?? null,
          keep,
        );

        // Deletion is never the default. A plan that prints and stops is recoverable; one
        // that deletes because it was run is not.
        if (flags.yes !== true) {
          // Only offer `--yes` when it would do something. Telling a user to re-run a
          // command that has nothing to remove is an instruction to no purpose.
          const next =
            plan.remove.length === 0 ? '' : '\n\nNothing was removed. Re-run with --yes to apply.';
          return {
            human: `${renderRetentionPlan(plan)}${next}`,
            json: { ...plan, applied: false },
          };
        }

        const lock = new ProjectLock(join(loreDirectory, 'lock'));
        await lock.withLock(() => {
          for (const id of plan.remove) state.forgetBuild(id);
          applyRetention(loreDirectory, plan);
        });

        // "Removed." after "Nothing to remove." claimed a deletion that never happened.
        const outcome =
          plan.remove.length === 0
            ? ''
            : `\n\nRemoved ${count(plan.remove.length, 'build')} and ${count(plan.objectsToRemove.length, 'object')}.`;
        return {
          human: `${renderRetentionPlan(plan)}${outcome}`,
          json: { ...plan, applied: true },
        };
      } finally {
        state.close();
      }
    },
  };
}

function parseKeep(raw: unknown): number {
  if (raw === undefined) return DEFAULT_KEEP_PREVIOUS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `--keep must be a whole number, got ${raw}.`, {
      remediation: 'Pass a count, for example `--keep 10`.',
    });
  }
  return value;
}
