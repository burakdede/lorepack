import { assertBuildId, count, LoreError, loadConfig, loadProjectConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { type BuildResult, runBuild } from '../services/build.js';
import { validateExistingBuild } from '../services/validate_existing.js';

/**
 * Validate a newly compiled candidate or verify retained data without activating it.
 *
 * This is intentionally a separate verb from `build --no-activate`: the lifecycle
 * acceptance path has a distinct validation step, and a person should not need to
 * know an implementation flag to verify a candidate safely.
 */
export function validateCommand(): CommandDefinition {
  return {
    name: 'validate',
    description: 'Validate a compiled candidate or verify a selected retained build.',
    flags: [
      {
        flags: '--build <id>',
        description: 'verify this full retained build id without compiling sources',
      },
      { flags: '--frozen', description: 'fail if lore.lock would change' },
      { flags: '--allow-large-project', description: 'continue past the supported file count' },
    ],
    handler: async (_args, flags, context): Promise<CommandResult> => {
      if (typeof flags.build === 'string') {
        const buildId = assertBuildId(flags.build);
        if (flags.frozen === true || flags.allowLargeProject === true) {
          throw new LoreError(
            'LORE_E_INVALID_ARGUMENT',
            'Compile flags cannot accompany retained-build validation.',
            {
              remediation:
                'Use --build alone to verify retained data, or omit --build to compile a candidate.',
            },
          );
        }
        const result = await validateExistingBuild(
          loadProjectConfig({ cwd: context.options.cwd }),
          buildId,
          context.signal,
        );
        return {
          human: `Verified retained build ${result.buildId}.\nSources, stored build data and the active pointer were not changed.`,
          json: result,
        };
      }
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
    lines.push(`Already valid. The build is ${result.buildId}.`);
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
