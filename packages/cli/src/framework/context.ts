import { resolve } from 'node:path';
import { ProgressBus, ProgressRenderer, shouldUseColor } from '@lorepack/core';

export interface GlobalOptions {
  readonly json: boolean;
  readonly verbose: boolean;
  readonly color: boolean;
  readonly cwd: string;
}

export interface Streams {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTty: boolean;
}

/**
 * Everything a command handler is given. Handlers return a result or throw; they never
 * call `process.exit` and never format an error, so the shell owns both.
 */
export interface CommandContext {
  readonly options: GlobalOptions;
  readonly streams: Streams;
  readonly progress: ProgressBus;
  /** Structured result for `--json`. Human output goes through `write`. */
  readonly write: (text: string) => void;
  readonly warn: (text: string) => void;
}

export function resolveGlobalOptions(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  isTty: boolean,
): GlobalOptions {
  return {
    json: raw.json === true,
    verbose: raw.verbose === true,
    // commander maps --no-color to color: false.
    color: raw.color === false ? false : shouldUseColor(env, isTty),
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
export function createContext(options: GlobalOptions, streams: Streams): CommandContext {
  const progress = new ProgressBus();
  const humanTarget = options.json ? streams.stderr : streams.stdout;

  const renderer = new ProgressRenderer({
    write: (text) => humanTarget.write(text),
    isTty: options.json ? false : streams.isTty,
    color: options.color,
  });
  progress.subscribe((event) => {
    if (event.type === 'diagnostic' && event.level === 'debug' && !options.verbose) return;
    renderer.handle(event);
  });

  return {
    options,
    streams,
    progress,
    write: (text) => humanTarget.write(text),
    warn: (text) => streams.stderr.write(text),
  };
}
