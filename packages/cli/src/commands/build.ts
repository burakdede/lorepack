import { count, loadConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { type BuildResult, runBuild } from '../services/build.js';

export function buildCommand(): CommandDefinition {
  return {
    name: 'build',
    description: 'Compile the project into an immutable build and activate it.',
    flags: [
      { flags: '--no-activate', description: 'verify a candidate without moving the pointer' },
      { flags: '--frozen', description: 'fail if lore.lock would change' },
      { flags: '--allow-large-project', description: 'continue past the supported file count' },
    ],
    handler: async (_args, flags, context): Promise<CommandResult> => {
      const config = loadConfig({ cwd: context.options.cwd });

      // Commander maps `--no-activate` to `activate: false`, defaulting to true.
      const result = await runBuild({
        config,
        progress: context.progress,
        activate: flags.activate !== false,
        frozen: flags.frozen === true,
        allowLargeProject: flags.allowLargeProject === true,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });

      return { human: render(result), json: result };
    },
  };
}

function render(result: BuildResult): string {
  const lines: string[] = [];

  if (!result.created) {
    lines.push(`No changes. The active build is ${result.buildId}.`);
    return lines.join('\n');
  }

  lines.push(`Build ${result.buildId}`);
  lines.push('');
  lines.push(`  ${count(result.counts.artifacts, 'artifact')}`);
  lines.push(`  ${count(result.counts.nodes, 'node')}`);
  lines.push(`  ${count(result.counts.chunks, 'chunk')}`);
  // Only when there are some. A line reading "0 tables" on every Markdown project is noise
  // that trains people to stop reading the summary, and this one has something to say.
  if (result.counts.tables > 0) {
    lines.push(
      `  ${count(result.counts.tables, 'table')}, ${count(result.counts.tableRows, 'row')}`,
    );
  }
  if (result.reusedArtifacts > 0)
    lines.push(`  ${count(result.reusedArtifacts, 'artifact')} reused`);
  if (result.warnings > 0) lines.push(`  ${count(result.warnings, 'warning')}`);
  lines.push('');
  lines.push(
    result.activated
      ? `Activated in ${result.durationMs} ms.`
      : `Verified in ${result.durationMs} ms. Not activated, because --no-activate was given.`,
  );

  return lines.join('\n');
}
