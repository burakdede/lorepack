import { buildLockfile, createPlan, readLockfile, renderPlan } from '@lorepack/compiler';
import { loadConfig } from '@lorepack/core';
import { markdownParser, textParser } from '@lorepack/parsers';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { readPreviousBuild } from '../services/project.js';

export const COMPILER_VERSION = '0.1.0' as const;
export const SCHEMA_VERSION = 1 as const;

export function lockInputs(): {
  compilerVersion: string;
  schemaVersion: number;
  parserVersions: Record<string, string>;
} {
  return {
    compilerVersion: COMPILER_VERSION,
    schemaVersion: SCHEMA_VERSION,
    parserVersions: {
      [markdownParser.id]: markdownParser.version,
      [textParser.id]: textParser.version,
    },
  };
}

export function planCommand(): CommandDefinition {
  return {
    name: 'plan',
    description: 'Preview what a build would change. Makes no changes itself.',
    flags: [
      { flags: '--allow-large-project', description: 'continue past the supported file count' },
      { flags: '--exit-code', description: 'exit 2 when there are changes, for CI gating' },
    ],
    handler: async (_args, flags, context): Promise<CommandResult> => {
      const config = loadConfig({ cwd: context.options.cwd });
      const { state, previous } = readPreviousBuild(config);

      try {
        const { plan } = await createPlan({
          config,
          previous,
          previousLock: readLockfile(config.projectRoot),
          lockInputs: lockInputs(),
          progress: context.progress,
          allowLargeProject: flags.allowLargeProject === true,
        });

        const hasChanges =
          plan.artifacts.added + plan.artifacts.changed + plan.artifacts.removed > 0 ||
          plan.lock.changed;

        return {
          human: renderPlan(plan),
          json: plan,
          // Exit 0 by default whether or not there are changes: a plan reporting work is
          // a normal outcome, not a failure. CI opts into the gate explicitly.
          ...(flags.exitCode === true && hasChanges ? { exitCode: 2 } : {}),
        };
      } finally {
        state?.close();
      }
    },
  };
}

export { buildLockfile };
