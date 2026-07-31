import type { CommandDefinition } from '../framework/program.js';

/**
 * Commands are registered explicitly. No dynamic discovery: architecture section 4.8
 * applies to the CLI as much as to adapters, and an explicit list is what makes
 * `lore --help` reviewable in a pull request.
 *
 * Each command lands with its own issue and adds one entry here.
 */
export function registerCommands(): CommandDefinition[] {
  return [];
}
