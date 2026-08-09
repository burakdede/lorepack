import type { CommandDefinition } from '../framework/program.js';
import { activateCommand, buildsCommand, rollbackCommand } from './activate.js';
import { buildCommand } from './build.js';
import { configCommand } from './config.js';
import { connectCommand, disconnectCommand } from './connect.js';
import { deployCommand } from './deploy.js';
import { devCommand } from './dev.js';
import { diffCommand } from './diff.js';
import { doctorCommand } from './doctor.js';
import { exportCommand } from './export.js';
import { initCommand } from './init.js';
import { inspectCommand } from './inspect.js';
import { mcpCommand } from './mcp.js';
import { packCommand } from './pack.js';
import { planCommand } from './plan.js';
import { pruneCommand } from './prune.js';
import { searchCommand } from './search.js';
import { serveCommand } from './serve.js';
import { statusCommand } from './status.js';
import { targetCommand } from './target.js';

/**
 * Commands are registered explicitly. No dynamic discovery: architecture section 4.8
 * applies to the CLI as much as to adapters, and an explicit list is what makes
 * `lore --help` reviewable in a pull request.
 */
export function registerCommands(): CommandDefinition[] {
  return [
    initCommand(),
    planCommand(),
    buildCommand(),
    statusCommand(),
    diffCommand(),
    searchCommand(),
    inspectCommand(),
    packCommand(),
    buildsCommand(),
    activateCommand(),
    rollbackCommand(),
    pruneCommand(),
    devCommand(),
    deployCommand(),
    targetCommand(),
    connectCommand(),
    disconnectCommand(),
    doctorCommand(),
    configCommand(),
    mcpCommand(),
    serveCommand(),
    exportCommand(),
  ];
}
