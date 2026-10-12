import type { CommandDefinition } from '../framework/program.js';
import { importArchive } from '../services/importing.js';

export function importCommand(): CommandDefinition {
  return {
    name: 'import',
    description: 'Verify and retain a portable build without compiling or activating it.',
    arguments: [{ name: 'file', description: '.lorepack archive to import' }],
    handler: async (args, _flags, context) => {
      const result = await importArchive(context.options.cwd, args[0] ?? '');
      return {
        human: `Imported ${result.buildId}. Integrity verified; publisher unsigned.\nActivate with: lorepack activate ${result.buildId}`,
        json: result,
      };
    },
  };
}
