import { isAbsolute, resolve } from 'node:path';
import { CONFIG_FILENAME, LoreError } from '@lorepack/core';
import type { CommandContext } from '../framework/context.js';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { enclosingProject, type InitResult, planInit, runInit } from '../services/init.js';

function renderHuman(result: InitResult, dryRun: boolean): string {
  const lines: string[] = [];

  if (result.alreadyInitialized && result.written.length === 0 && !dryRun) {
    lines.push(`Already initialized: ${CONFIG_FILENAME} exists. Nothing was changed.`);
    if (result.creates.length > 0) {
      lines.push('');
      lines.push('Created the missing files:');
      for (const file of result.creates) lines.push(`  + ${file}`);
    }
    if (result.forceWouldChange.length > 0) {
      lines.push('');
      lines.push(
        result.configDiffers
          ? 'Your configuration differs from a freshly generated one. `--force` would overwrite:'
          : '`--force` would rewrite:',
      );
      for (const file of result.forceWouldChange) lines.push(`  ~ ${file}`);
    }
  } else {
    lines.push(dryRun ? 'Would create:' : 'Created:');
    for (const file of result.creates) lines.push(`  + ${file}`);
    for (const file of result.modifies) lines.push(`  ~ ${file}`);
    if (result.creates.length === 0 && result.modifies.length === 0) lines.push('  nothing');
  }

  if (result.secretShaped.length > 0) {
    lines.push('');
    lines.push(
      `Warning: ${result.secretShaped.length} file(s) look like credentials and will never be indexed:`,
    );
    for (const file of result.secretShaped.slice(0, 10)) lines.push(`  ${file}`);
    if (result.secretShaped.length > 10) {
      lines.push(`  and ${result.secretShaped.length - 10} more`);
    }
    lines.push('This is a guardrail on filenames, not a secret scanner.');
  }

  if (!dryRun && result.written.length > 0) {
    lines.push('');
    lines.push('Next: run `lore build` to create your first build.');
  }
  return lines.join('\n');
}

export function initCommand(): CommandDefinition {
  return {
    name: 'init',
    description: 'Create a minimal Lorepack project in a directory.',
    arguments: [{ name: 'path', description: 'project directory (default: .)', required: false }],
    flags: [
      { flags: '--force', description: 'overwrite existing Lorepack configuration' },
      { flags: '--dry-run', description: 'show what would change without writing' },
    ],
    handler: (args, flags, context): CommandResult => {
      const directory = resolveDirectory(args[0], context);
      const force = flags.force === true;
      const dryRun = flags.dryRun === true;

      const enclosing = enclosingProject(directory);
      if (enclosing !== null && !force) {
        throw new LoreError(
          'LORE_E_INVALID_ARGUMENT',
          `${directory} is already inside a Lorepack project rooted at ${enclosing}.`,
          {
            remediation:
              'Nested projects are not supported. Run `lore build` in the existing project, or pass --force if you really want a separate one.',
          },
        );
      }

      const result = dryRun
        ? { ...planInit({ directory, force, dryRun: true }), written: [] }
        : runInit({ directory, force });

      return { human: renderHuman(result, dryRun), json: result };
    },
  };
}

function resolveDirectory(argument: string | undefined, context: CommandContext): string {
  if (argument === undefined) return context.options.cwd;
  return isAbsolute(argument) ? resolve(argument) : resolve(context.options.cwd, argument);
}
