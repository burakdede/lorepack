import { count, LoreError, loadConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import {
  closestPath,
  displayValue,
  ENVIRONMENT_KEYS,
  type ResolvedConfiguration,
  type ResolvedValue,
  resolveConfiguration,
} from '../services/config-resolve.js';

/**
 * `lore config show --effective` and `lore config explain <path>`.
 *
 * Architecture 4.9's transparent-magic contract: defaults work, and nothing is hidden. The
 * test of it is whether a user can learn what Lorepack decided without reading the source,
 * which a bare value does not satisfy. Every line here carries the layer that supplied it,
 * and every value says whether changing it would change the build id.
 */

export function configCommand(): CommandDefinition {
  return {
    name: 'config',
    description: 'Show the resolved configuration, and where each value came from.',
    arguments: [
      { name: 'subject', description: 'show or explain', required: true },
      {
        name: 'path',
        description: 'for explain: a dotted key, e.g. chunking.targetTokens',
        required: false,
      },
    ],
    flags: [
      {
        flags: '--effective',
        description: 'show every resolved value, not only what lore.yaml says',
      },
    ],
    handler: (args, flags, context): CommandResult => {
      const subject = args[0];
      const config = loadConfig({ cwd: context.options.cwd });
      const resolved = resolveConfiguration(config);

      if (subject === 'show') return show(resolved, flags.effective === true);
      if (subject === 'explain') return explain(resolved, args[1]);

      throw new LoreError('LORE_E_INVALID_ARGUMENT', `Unknown config subject: ${subject}.`, {
        remediation: 'Use `lore config show --effective` or `lore config explain <path>`.',
        subject: String(subject),
      });
    },
  };
}

function show(resolved: ResolvedConfiguration, effective: boolean): CommandResult {
  // Without `--effective` the interesting subset is what someone chose, because that is what
  // they can edit. With it, everything, which is the point of the flag.
  const shown = effective
    ? resolved.values
    : resolved.values.filter((entry) => entry.layer !== 'defaults');

  const lines: string[] = [];
  lines.push(
    effective
      ? `Effective configuration for ${resolved.projectRoot}`
      : `Configured values for ${resolved.projectRoot} (run with --effective for all of them)`,
  );
  lines.push('');

  const width = Math.max(...shown.map((entry) => entry.path.length), 10);
  for (const entry of shown) {
    // A leading `#` marks the values the build id is computed from, so the distinction is
    // visible rather than something to look up.
    const mark = entry.buildId ? '#' : ' ';
    lines.push(`${mark} ${entry.path.padEnd(width)}  ${displayValue(entry)}   [${entry.layer}]`);
  }

  lines.push('');
  lines.push(
    `# marks the ${count(shown.filter((entry) => entry.buildId).length, 'value')} the build id is computed from.`,
  );
  if (effective) {
    lines.push(
      `Serving bounds are shown and are not part of it: a port decides nothing about what a build contains.`,
    );
  }
  return { human: lines.join('\n'), json: { projectRoot: resolved.projectRoot, values: shown } };
}

function explain(resolved: ResolvedConfiguration, path: string | undefined): CommandResult {
  if (path === undefined) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', 'explain needs a configuration path.', {
      remediation: 'For example: `lore config explain chunking.targetTokens`.',
    });
  }

  const entry = resolved.values.find((candidate) => candidate.path === path);
  if (entry === undefined) {
    const known = resolved.values.map((candidate) => candidate.path);
    const closest = closestPath(path, known);
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `No configuration value at ${path}.`, {
      remediation:
        closest === null
          ? 'Run `lore config show --effective` to see every path.'
          : `Did you mean ${closest}? Run \`lore config show --effective\` to see every path.`,
      subject: path,
    });
  }

  return { human: renderOne(entry), json: entry };
}

function renderOne(entry: ResolvedValue): string {
  const lines = [
    `${entry.path}`,
    '',
    `  value   ${displayValue(entry)}`,
    `  layer   ${entry.layer}`,
    `  source  ${entry.source}`,
    `  build   ${entry.buildId ? 'this value is part of the build id' : 'changing this does not change the build id'}`,
  ];

  if (entry.layer === 'defaults') {
    lines.push('');
    lines.push(
      'Nothing set this, so the built-in default applies. Set it in lore.yaml to change it.',
    );
  }
  if (entry.layer === 'environment') {
    lines.push('');
    lines.push(`Set by the environment variable ${entry.source}. Unset it to fall back.`);
  }
  return lines.join('\n');
}

/** The documented environment layer, exported so the documentation and the code agree. */
export { ENVIRONMENT_KEYS };
