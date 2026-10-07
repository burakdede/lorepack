export { registerCommands } from './commands/index.js';
export { initCommand } from './commands/init.js';
export {
  type CommandContext,
  createContext,
  type GlobalOptions,
  resolveGlobalOptions,
  type Streams,
} from './framework/context.js';
export {
  type CommandArgumentDefinition,
  type CommandExample,
  type CommandFlagDefinition,
  type CommandMetadata,
  type CompletionContext,
  type CompletionProvider,
  type CompletionValueKind,
  validateCommandMetadata,
} from './framework/metadata.js';
export {
  buildProgram,
  CLI_NAME,
  type CommandDefinition,
  type CommandHandler,
  type CommandResult,
  type RunOptions,
  runCli,
} from './framework/program.js';
export {
  enclosingProject,
  findSecretShaped,
  type InitOptions,
  type InitPlan,
  type InitResult,
  planInit,
  projectNameFrom,
  renderConfig,
  renderIgnore,
  runInit,
} from './services/init.js';
