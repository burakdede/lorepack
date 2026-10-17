import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { type ErrorCode, LoreError, type ProgressEvent } from '@lorepack/core';
import type { BuildOptions, BuildResult } from './build.js';

export type BackgroundBuildOptions = Pick<
  BuildOptions,
  'config' | 'progress' | 'signal' | 'activate' | 'allowLargeProject'
>;

export interface BuildWorkerInput {
  readonly config: BuildOptions['config'];
  readonly activate?: boolean;
  readonly allowLargeProject?: boolean;
}

interface BuildFailure {
  readonly kind: 'failed';
  readonly error: unknown;
  readonly lore?: {
    readonly code: ErrorCode;
    readonly remediation: string | undefined;
    readonly path: string | undefined;
    readonly subject: string | undefined;
    readonly details: Readonly<Record<string, unknown>> | undefined;
  };
}

export type BuildWorkerReply =
  | { readonly kind: 'progress'; readonly event: ProgressEvent }
  | { readonly kind: 'built'; readonly result: BuildResult }
  | BuildFailure;

function buildFailure(reply: BuildFailure): unknown {
  if (reply.lore === undefined || !(reply.error instanceof Error)) return reply.error;
  const { code, remediation, path, subject, details } = reply.lore;
  const error = new LoreError(code, reply.error.message, {
    ...(remediation === undefined ? {} : { remediation }),
    ...(path === undefined ? {} : { path }),
    ...(subject === undefined ? {} : { subject }),
    ...(details === undefined ? {} : { details }),
    ...(reply.error.cause === undefined ? {} : { cause: reply.error.cause }),
  });
  if (reply.error.stack !== undefined) error.stack = reply.error.stack;
  return error;
}

function workerEntry(): URL {
  const sibling = new URL('./build_worker.js', import.meta.url);
  if (existsSync(sibling)) return sibling;
  // Source-based tests still run the compiled worker, as the published CLI does.
  const compiled = new URL('../../dist/services/build_worker.js', import.meta.url);
  if (existsSync(compiled)) return compiled;
  throw new LoreError('LORE_E_INTERNAL', 'The build worker is missing from this install.', {
    remediation: 'Reinstall Lorepack. From a checkout, run `pnpm build` first.',
    subject: 'build_worker.js',
  });
}

/** Keep synchronous compiler and filesystem work off the serving event loop. */
export function runBackgroundBuild(options: BackgroundBuildOptions): Promise<BuildResult> {
  const input: BuildWorkerInput = {
    config: options.config,
    ...(options.activate === undefined ? {} : { activate: options.activate }),
    ...(options.allowLargeProject === undefined
      ? {}
      : {
          allowLargeProject: options.allowLargeProject,
        }),
  };
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerEntry(), { workerData: input });
    let reply: Exclude<BuildWorkerReply, { kind: 'progress' }> | undefined;
    let failure: { error: unknown } | undefined;
    const abort = () => worker.postMessage({ kind: 'abort' });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    worker.on('message', (message: BuildWorkerReply) => {
      if (message.kind !== 'progress') {
        reply = message;
      } else if (failure === undefined) {
        try {
          options.progress.emit(message.event);
        } catch (error) {
          failure = { error };
          abort();
        }
      }
    });
    worker.once('error', (error) => {
      failure ??= { error };
    });
    worker.once('exit', (code) => {
      options.signal?.removeEventListener('abort', abort);
      if (failure !== undefined) reject(failure.error);
      else if (reply?.kind === 'failed') reject(buildFailure(reply));
      else if (code === 0 && reply?.kind === 'built') resolve(reply.result);
      else
        reject(
          new LoreError(
            'LORE_E_INTERNAL',
            `The build worker exited without a result (code ${code}).`,
            {
              remediation: 'Check the build diagnostics and try again.',
            },
          ),
        );
    });
  });
}
