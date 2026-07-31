import { loadConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { readStatus, renderStatus } from '../services/status.js';

export function statusCommand(): CommandDefinition {
  return {
    name: 'status',
    description: 'Report whether the active build still matches the sources.',
    flags: [
      { flags: '--exit-code', description: 'exit 2 when sources are dirty, for scripting' },
      { flags: '--allow-large-project', description: 'continue past the supported file count' },
    ],
    handler: async (_args, flags, context): Promise<CommandResult> => {
      const config = loadConfig({ cwd: context.options.cwd });
      const status = await readStatus({
        config,
        progress: context.progress,
        allowLargeProject: flags.allowLargeProject === true,
      });

      return {
        human: renderStatus(status, context.options.verbose),
        json: status,
        // Dirty is a normal state, not a failure, so the non-zero exit is opt-in.
        ...(flags.exitCode === true && status.sourceState === 'dirty' ? { exitCode: 2 } : {}),
      };
    },
  };
}
