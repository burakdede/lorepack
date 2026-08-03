import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyArchive } from '@lorepack/backend-local';
import { count, LoreError, loadConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { packBuild } from '../services/packing.js';

/**
 * `lore pack` writes a `.lorepack` archive: a standard, inspectable ZIP.
 *
 * Nothing about it is clever, and that is the feature. Section 22.3 promises no lock-in,
 * which only means something if a plain `unzip` can open the file without Lorepack.
 */
export function packCommand(): CommandDefinition {
  return {
    name: 'pack',
    description: 'Write a portable .lorepack archive of a build.',
    arguments: [{ name: 'build', description: 'build id or prefix', required: false }],
    flags: [
      { flags: '--verify <file>', description: 'check an existing archive instead of writing one' },
      { flags: '--out <file>', description: 'archive path to write' },
    ],
    handler: async (args, flags, context): Promise<CommandResult> => {
      if (typeof flags.verify === 'string') return verify(flags.verify, context.options.cwd);

      const config = loadConfig({ cwd: context.options.cwd });
      const result = await packBuild(config, {
        build: args[0],
        out: typeof flags.out === 'string' ? flags.out : undefined,
        relativeTo: context.options.cwd,
      });

      return {
        human: `Wrote ${result.archive}\n  ${count(result.members, 'member')}, including the checksum index.`,
        json: { ...result },
      };
    },
  };
}

async function verify(file: string, cwd: string): Promise<CommandResult> {
  const path = resolve(cwd, file);
  if (!existsSync(path)) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `${file} does not exist.`, {
      remediation: 'Pass the path to a .lorepack archive.',
    });
  }

  const result = await verifyArchive(path);
  if (result.ok) {
    return {
      human: `${path} is intact. ${count(result.memberCount, 'member')} verified.`,
      json: { archive: path, ...result },
    };
  }

  const first = result.failures[0];
  throw new LoreError(
    'LORE_E_OBJECT_CORRUPT',
    `${path} failed verification: ${first?.member} is ${first?.reason}.`,
    {
      remediation: 'Download or pack the archive again. Its contents cannot be trusted.',
      details: { failures: result.failures },
    },
  );
}
