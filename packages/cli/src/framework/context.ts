import { resolve } from 'node:path';
import { ProgressBus, ProgressRenderer, shouldUseColor } from '@lorepack/core';

export interface GlobalOptions {
  readonly json: boolean;
  readonly verbose: boolean;
  /** Colour for stdout. */
  readonly color: boolean;
  /**
   * Colour for stderr, resolved separately because the two streams are redirected
   * separately. `lore build > log.txt` on a terminal keeps its errors readable, and
   * `lore build 2> log.txt` does not put escapes in the file.
   */
  readonly colorStderr: boolean;
  readonly cwd: string;
}

export interface Streams {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTty: boolean;
  readonly errorIsTty?: boolean;
  /** Terminal width, when there is a terminal. Progress lines are truncated to it. */
  readonly columns?: number | undefined;
}

/**
 * Everything a command handler is given. Handlers return a result or throw; they never
 * call `process.exit` and never format an error, so the shell owns both.
 */
export interface CommandContext {
  readonly options: GlobalOptions;
  readonly streams: Streams;
  readonly progress: ProgressBus;
  /**
   * Aborted when the user interrupts. Long-running commands check it between stages; a
   * command that ignores it simply is not cancellable, which is correct for short ones.
   */
  readonly signal?: AbortSignal;
  /** Structured result for `--json`. Human output goes through `write`. */
  readonly write: (text: string) => void;
  readonly warn: (text: string) => void;
}

export function resolveGlobalOptions(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  isTty: boolean,
  errorIsTty: boolean = isTty,
): GlobalOptions {
  // commander maps --no-color to color: false.
  const forbidden = raw.color === false;
  return {
    json: raw.json === true,
    verbose: raw.verbose === true,
    color: forbidden ? false : shouldUseColor(env, isTty),
    colorStderr: forbidden ? false : shouldUseColor(env, errorIsTty),
    cwd: resolve(typeof raw.cwd === 'string' ? raw.cwd : process.cwd()),
  };
}

/**
 * Builds the per-invocation context.
 *
 * With `--json`, stdout carries the structured result and nothing else, so progress and
 * warnings move to stderr. That is what makes `lore plan --json | jq` work, and it is the
 * same discipline `lore mcp` will need for protocol purity in Phase 2.
 */
export function createContext(
  options: GlobalOptions,
  streams: Streams,
  signal?: AbortSignal,
): CommandContext {
  const progress = new ProgressBus();
  const humanTarget = options.json ? streams.stderr : streams.stdout;

  // Under --json, progress moves to stderr, so it is stderr's terminal that decides both
  // whether to rewrite a line in place and whether colour is welcome.
  const humanIsTty = options.json ? (streams.errorIsTty ?? streams.isTty) : streams.isTty;
  const renderer = new ProgressRenderer({
    write: (text) => humanTarget.write(text),
    isTty: options.json ? false : streams.isTty,
    color: options.json ? options.colorStderr : options.color,
    columns: humanIsTty ? streams.columns : undefined,
  });
  progress.subscribe((event) => {
    if (event.type === 'diagnostic' && event.level === 'debug' && !options.verbose) return;
    renderer.handle(event);
  });

  return {
    options,
    streams,
    progress,
    ...(signal === undefined ? {} : { signal }),
    write: (text) => humanTarget.write(text),
    warn: (text) => streams.stderr.write(text),
  };
}
