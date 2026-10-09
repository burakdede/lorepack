import { count, loadConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { type BuildResult, runBuild } from '../services/build.js';

/**
 * Compile and validate a candidate without moving the active pointer.
 *
 * This is intentionally a separate verb from `build --no-activate`: the lifecycle
 * acceptance path has a distinct validation step, and a person should not need to
 * know an implementation flag to verify a candidate safely.
 */
export function validateCommand(): CommandDefinition {
  return {
    name: 'validate',
    description: 'Compile and validate a candidate without activating it.',
    flags: [
      { flags: '--frozen', description: 'fail if lore.lock would change' },
      { flags: '--allow-large-project', description: 'continue past the supported file count' },
    ],
    handler: async (_args, flags, context): Promise<CommandResult> => {
      const config = loadConfig({ cwd: context.options.cwd });
      const result = await runBuild({
        config,
        progress: context.progress,
        activate: false,
        frozen: flags.frozen === true,
        allowLargeProject: flags.allowLargeProject === true,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });

      return { human: render(result), json: result };
    },
  };
}

function render(result: BuildResult): string {
  const lines = [];

  if (!result.created) {
    lines.push(`Already valid. The active build is ${result.buildId}.`);
    return lines.join('\n');
  }

  lines.push(`Validated ${result.buildId}`);
  lines.push('');
  lines.push(`  ${count(result.counts.artifacts, 'artifact')}`);
  lines.push(`  ${count(result.counts.nodes, 'node')}`);
  lines.push(`  ${count(result.counts.chunks, 'chunk')}`);
  if (result.counts.tables > 0) {
    lines.push(
      `  ${count(result.counts.tables, 'table')}, ${count(result.counts.tableRows, 'row')}`,
    );
  }
  if (result.reusedArtifacts > 0)
    lines.push(`  ${count(result.reusedArtifacts, 'artifact')} reused`);
  if (result.warnings > 0) lines.push(`  ${count(result.warnings, 'warning')}`);
  lines.push('');
  lines.push(`Verified in ${result.durationMs} ms. The active build was not changed.`);

  return lines.join('\n');
}
