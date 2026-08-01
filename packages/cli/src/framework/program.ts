import { EXIT_CODES, LoreError, renderAsJson, renderForCli } from '@lorepack/core';
import { Command, CommanderError } from 'commander';
import { registerCommands } from '../commands/index.js';
import {
  type CommandContext,
  createContext,
  resolveGlobalOptions,
  type Streams,
} from './context.js';
import { exitAfterFlush } from './exit.js';

export const CLI_NAME = 'lore' as const;

export interface CommandResult {
  /** Rendered for humans. Omit when the command has already written its own output. */
  readonly human?: string;
  /** Emitted verbatim under `--json`. */
  readonly json?: unknown;
  /** Overrides the success exit code, for flags like `--exit-code`. */
  readonly exitCode?: number;
}

/** Returning nothing means the command wrote its own output and has no structured result. */
export type CommandHandler = (
  args: readonly string[],
  flags: Record<string, unknown>,
  context: CommandContext,
) => Promise<CommandResult | undefined> | CommandResult | undefined;

export interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly arguments?: readonly { name: string; description: string; required?: boolean }[];
  readonly flags?: readonly { flags: string; description: string; defaultValue?: unknown }[];
  readonly handler: CommandHandler;
}

export interface RunOptions {
  readonly streams?: Streams;
  readonly env?: NodeJS.ProcessEnv;
  readonly version?: string;
  /** Set false in tests, which assert on the returned code instead of exiting. */
  readonly exitProcess?: boolean;
  /** Overrides the registered command list. Tests inject fixtures through this. */
  readonly commands?: readonly CommandDefinition[];
  /**
   * Cancellation for long-running commands. `runCli` installs SIGINT and SIGTERM handlers
   * when it owns the process; tests pass their own signal and skip the handlers.
   */
  readonly signal?: AbortSignal;
}

function defaultStreams(): Streams {
  return { stdout: process.stdout, stderr: process.stderr, isTty: process.stdout.isTTY === true };
}

export interface ProgramHooks {
  /** Called as soon as a context exists, before the handler runs, so a thrown error can
   *  still be rendered in the mode the user asked for. */
  readonly onContext: (context: CommandContext) => void;
  readonly onResult: (result: CommandResult | undefined, context: CommandContext) => void;
}

export function buildProgram(
  definitions: readonly CommandDefinition[],
  options: RunOptions,
  hooks: ProgramHooks,
): Command {
  const streams = options.streams ?? defaultStreams();
  const program = new Command()
    .name(CLI_NAME)
    .description('Build, version, and deploy the context your AI depends on.')
    .version(options.version ?? '0.0.0', '-v, --version')
    .option('--json', 'emit machine-readable output on stdout', false)
    .option('--verbose', 'include stage detail and debug diagnostics', false)
    .option('--no-color', 'disable colour')
    .option('--cwd <path>', 'run against a project in another directory')
    .showSuggestionAfterError(true)
    .exitOverride();

  program.configureOutput({
    writeOut: (text) => streams.stdout.write(text),
    writeErr: (text) => streams.stderr.write(text),
    // Commander writes its own error before throwing, which would print the message twice
    // once the central handler renders it. Suppress the first: the thrown CommanderError
    // carries the same text, and one renderer owns how a failure looks.
    outputError: () => {},
  });

  for (const definition of definitions) {
    const command = program.command(definition.name).description(definition.description);
    for (const argument of definition.arguments ?? []) {
      command.argument(
        argument.required === false ? `[${argument.name}]` : `<${argument.name}>`,
        argument.description,
      );
    }
    for (const flag of definition.flags ?? []) {
      command.option(flag.flags, flag.description, flag.defaultValue as string | undefined);
    }
    command.exitOverride();
    command.action(async (...actionArguments: unknown[]) => {
      // commander passes positional arguments, then the options object, then the command.
      const commandInstance = actionArguments.at(-1) as Command;
      const flags = actionArguments.at(-2) as Record<string, unknown>;
      const positional = actionArguments
        .slice(0, -2)
        .filter((value): value is string => typeof value === 'string');

      const globalOptions = resolveGlobalOptions(
        { ...program.opts(), ...flags },
        options.env ?? process.env,
        streams.isTty,
      );
      const context = createContext(globalOptions, streams, options.signal);
      hooks.onContext(context);
      const result = await definition.handler(
        positional,
        { ...flags, _command: commandInstance },
        context,
      );
      hooks.onResult(result, context);
    });
  }

  return program;
}

/**
 * Runs the CLI and returns the exit code.
 *
 * Every failure funnels through here: a `LoreError` renders with its remediation and maps
 * to its documented exit code, and anything unexpected becomes `LORE_E_INTERNAL`. No
 * command decides how an error looks or what it exits with.
 */
export async function runCli(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const streams = options.streams ?? defaultStreams();
  const exitProcess = options.exitProcess ?? true;
  let code = 0;

  // One interrupt asks the current command to stop at its next checkpoint, which is what
  // lets a build discard its candidate and leave the active pointer alone. A second one
  // means the user is no longer asking, so the process ends immediately.
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const interrupt = (): void => {
    if (controller.signal.aborted) {
      // Still through the flush: the message explaining why the process is ending is the
      // one most likely to be lost, because nothing follows it to push the pipe along.
      void exitAfterFlush(EXIT_CODES.USER, streams);
      return;
    }
    controller.abort();
    streams.stderr.write('\nInterrupted. Finishing the current step and rolling back.\n');
  };
  const installHandlers = exitProcess && options.signal === undefined;
  if (installHandlers) {
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
  }
  // A holder rather than a plain `let`: the assignment happens inside a callback, and
  // control-flow analysis would otherwise narrow the variable to null at the catch site.
  const state: { context: CommandContext | null } = { context: null };

  const program = buildProgram(
    options.commands ?? registerCommands(),
    { ...options, streams, signal },
    {
      onContext: (context) => {
        state.context = context;
      },
      onResult: (result, context) => {
        if (result === undefined) return;
        if (context.options.json) {
          if (result.json !== undefined)
            streams.stdout.write(`${JSON.stringify(result.json, null, 2)}\n`);
        } else if (result.human !== undefined && result.human !== '') {
          streams.stdout.write(result.human.endsWith('\n') ? result.human : `${result.human}\n`);
        }
        if (result.exitCode !== undefined) code = result.exitCode;
      },
    },
  );

  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    // A parse failure happens before any context exists, so fall back to scanning argv:
    // a user who asked for --json should get JSON even when the argument itself was wrong.
    const jsonRequested = state.context?.options.json === true || argv.includes('--json');
    code = handleFailure(error, streams, state.context, jsonRequested);
  }

  if (installHandlers) {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }

  if (exitProcess) await exitAfterFlush(code, streams);
  return code;
}

function handleFailure(
  error: unknown,
  streams: Streams,
  context: CommandContext | null,
  jsonRequested: boolean,
): number {
  // commander throws for --help and --version, which are successful outcomes.
  if (error instanceof CommanderError) {
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return 0;
    if (error.code === 'commander.help') return 0;
    // Every argument-shaped failure becomes a typed error, so a user sees one format and
    // a script sees one exit code. `excessArguments` is what commander reports for an
    // unknown command when no subcommands are registered yet.
    const argumentCodes = new Set([
      'commander.unknownCommand',
      'commander.unknownOption',
      'commander.excessArguments',
      'commander.missingArgument',
      'commander.invalidArgument',
      'commander.missingMandatoryOptionValue',
      'commander.optionMissingArgument',
    ]);
    if (argumentCodes.has(error.code)) {
      const wrapped = new LoreError(
        'LORE_E_INVALID_ARGUMENT',
        error.message.replace(/^error:\s*/i, '').trim(),
        { remediation: `Run \`${CLI_NAME} --help\` to see available commands and options.` },
      );
      if (jsonRequested) {
        streams.stdout.write(`${JSON.stringify(renderAsJson(wrapped), null, 2)}\n`);
      } else {
        streams.stderr.write(`${renderForCli(wrapped)}\n`);
      }
      return EXIT_CODES.USER;
    }
    streams.stderr.write(error.message.endsWith('\n') ? error.message : `${error.message}\n`);
    return error.exitCode === 0 ? EXIT_CODES.USER : error.exitCode;
  }

  const loreError = LoreError.from(error);
  if (jsonRequested) {
    streams.stdout.write(`${JSON.stringify(renderAsJson(loreError), null, 2)}\n`);
  } else {
    streams.stderr.write(
      `${renderForCli(loreError, { verbose: context?.options.verbose === true })}\n`,
    );
  }
  return loreError.exitCode;
}
