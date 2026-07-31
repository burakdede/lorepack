import type { CommandDefinition } from '../framework/program.js';
import { buildCommand } from './build.js';
import { initCommand } from './init.js';
import { planCommand } from './plan.js';
import { statusCommand } from './status.js';

/**
 * Commands are registered explicitly. No dynamic discovery: architecture section 4.8
 * applies to the CLI as much as to adapters, and an explicit list is what makes
 * `lore --help` reviewable in a pull request.
 */
export function registerCommands(): CommandDefinition[] {
  return [initCommand(), planCommand(), buildCommand(), statusCommand()];
}
