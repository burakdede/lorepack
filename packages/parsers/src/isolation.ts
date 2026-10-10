import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ArtifactParser, ParsedArtifact, ParseInput } from '@lorepack/core';
import { type ChildReply, deserializeError } from './isolation-protocol.js';
import { PARSERS } from './registry-parsers.js';

/**
 * Runs each parse in a child process under a wall-clock deadline and a heap ceiling (#594).
 *
 * A parser is a pure function of its bytes, and that is not the same as a bounded one. Small,
 * valid documents drive the libraries underneath into quadratic time (micromark on nested
 * brackets), into gigabytes of inflated stream (pdfjs on a FlateDecode bomb, a `/ToUnicode`
 * CMap of a few huge ranges), or into V8's heap limit (mammoth on an inflated
 * `document.xml`). In-process, the first hangs the build with the project lock held and the
 * last aborts the whole process, which no `try` can turn into a diagnostic.
 *
 * **A process, not a worker thread.** `worker_threads` with `resourceLimits` was the first
 * design and it does not hold: on the CMap fixture at 512 MB and 2048 MB, and on a CSV of
 * single-character rows at 128 MB, V8 hit the worker's limit on a path that aborts the
 * *parent* (`FATAL ERROR: Reached heap limit`, exit 134) instead of raising
 * `ERR_WORKER_OUT_OF_MEMORY`. A child process aborting takes only itself with it.
 *
 * **One child, reused.** Builds parse sequentially, so a pool of one is enough, and starting
 * Node per file would cost more than most parses. The child is replaced only after it was
 * killed or died.
 *
 * **Only registered parsers are isolated.** The child builds its own registry and finds the
 * parser by id, so a parser that exists only in this process (an embedder's, or a test's) has
 * nothing to be found as there. It runs in-process and unbounded, as every parser did before.
 *
 * The limits are operational and never reach the build id. Which files they exclude does, through
 * the content, exactly like any other excluded file.
 */

export interface ParseLimits {
  /** Wall-clock time one parse may take, from the job being sent to the reply arriving. */
  readonly timeoutMs: number;
  /** V8's old-generation ceiling in the parse process (`--max-old-space-size`). */
  readonly memoryMb: number;
}

export const PARSE_LIMITS = {
  defaults: { timeoutMs: 30_000, memoryMb: 2048 },
  timeoutMs: { min: 100, max: 3_600_000 },
  memoryMb: { min: 64, max: 32_768 },
} as const;

export type ParseExclusionCode = 'parse-timeout' | 'parse-memory' | 'parse-crashed';

export type IsolatedParse =
  | { readonly kind: 'parsed'; readonly result: ParsedArtifact }
  | { readonly kind: 'excluded'; readonly code: ParseExclusionCode; readonly message: string }
  | { readonly kind: 'interrupted' };

/** How much of the child's stderr is kept. V8 prints its fatal line first, the stack after. */
const STDERR_HEAD_BYTES = 16 * 1024;

/** Windows reports a console interrupt as this exit status rather than as a signal. */
const WINDOWS_CONTROL_C_EXIT = 0xc000013a;

interface Child {
  readonly process: ChildProcess;
  readonly stderr: { head: string };
  /** Settles when the child has exited and its stderr has drained. */
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export class ParserHost {
  readonly #limits: ParseLimits;
  #child: Promise<Child> | null = null;

  constructor(limits: ParseLimits = PARSE_LIMITS.defaults) {
    this.#limits = limits;
  }

  async parse(
    parser: ArtifactParser,
    input: ParseInput,
    signal?: AbortSignal,
  ): Promise<IsolatedParse> {
    if (!PARSERS.includes(parser)) return { kind: 'parsed', result: await parser.parse(input) };
    const child = await this.#ready();
    // Checked after the start, not before: an abort while Node was starting fires no listener
    // added later, and the child it started is ended by `close` like any other.
    if (signal?.aborted === true) return { kind: 'interrupted' };
    return new Promise<IsolatedParse>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        child.process.off('message', onMessage);
        action();
      };
      const kill = (): void => {
        this.#child = null;
        child.process.kill('SIGKILL');
      };

      const timer = setTimeout(() => {
        kill();
        finish(() =>
          resolve({
            kind: 'excluded',
            code: 'parse-timeout',
            message: `Parsing took longer than ${seconds(this.#limits.timeoutMs)}, so the file was left out of the build. Set LORE_PARSE_TIMEOUT_MS to allow longer, or exclude the file in .loreignore.`,
          }),
        );
      }, this.#limits.timeoutMs);

      const onAbort = (): void => {
        kill();
        finish(() => resolve({ kind: 'interrupted' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const onMessage = (reply: ChildReply): void => {
        if (reply.kind === 'parsed')
          finish(() => resolve({ kind: 'parsed', result: reply.result }));
        else if (reply.kind === 'failed') finish(() => reject(deserializeError(reply.error)));
      };
      child.process.on('message', onMessage);

      void child.closed.then(({ code, signal: exitSignal }) => {
        if (settled) return;
        this.#child = null;
        finish(() => resolve(classifyExit(code, exitSignal, child.stderr.head, this.#limits)));
      });

      child.process.send({ parserId: parser.id, input });
    });
  }

  /** Ends the child. Safe to call more than once, and with no child started. */
  close(): void {
    const child = this.#child;
    this.#child = null;
    void child?.then((started) => started.process.kill('SIGKILL')).catch(() => undefined);
  }

  #ready(): Promise<Child> {
    this.#child ??= start(this.#limits).catch((error: unknown) => {
      this.#child = null;
      throw error;
    });
    return this.#child;
  }
}

function start(limits: ParseLimits): Promise<Child> {
  const child = fork(fileURLToPath(new URL('./parse-child.js', import.meta.url)), [], {
    // Explicit rather than inherited: the parent may run under a test runner's loader or a
    // debugger flag, and the child must start as a plain Node with only these set.
    //
    // The permission model is the second reason this is a process. A parser reads nothing but
    // the bytes it is sent, so the process that runs one on a hostile document gets read access
    // (its own modules) and nothing else: no file writes, no child process, no worker, no
    // addon. Node 24 has no network permission; the privacy sandbox covers that (#616).
    execArgv: ['--permission', '--allow-fs-read=*', `--max-old-space-size=${limits.memoryMb}`],
    // Structured clone rather than JSON, so `bytes` arrives as a `Uint8Array` and a parse
    // result arrives exactly as the parser built it.
    serialization: 'advanced',
    // Captured, not shown: pdfjs and friends write to the console, and a parser does not own
    // the build's output. Kept only to recognise V8's out-of-memory report.
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const stderr = { head: '' };
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.head.length < STDERR_HEAD_BYTES)
      stderr.head = (stderr.head + chunk).slice(0, STDERR_HEAD_BYTES);
  });
  // `close` rather than `exit`: only `close` waits for stderr to drain, and the line that says
  // the heap ran out is in it.
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  return new Promise<Child>((resolve, reject) => {
    const onMessage = (reply: ChildReply): void => {
      if (reply.kind !== 'ready') return;
      child.off('message', onMessage);
      resolve({ process: child, stderr, closed });
    };
    child.on('message', onMessage);
    // Kept for the child's whole life: an `error` event with no listener would throw in the
    // parent. A failed send to a child that died is answered by `close` below, not here.
    child.on('error', reject);
    void closed.then(({ code, signal }) =>
      reject(
        new Error(
          `The parse process exited before it was ready (${describeExit(code, signal)}). ${stderr.head.split('\n')[0] ?? ''}`.trim(),
        ),
      ),
    );
  });
}

function classifyExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
  limits: ParseLimits,
): IsolatedParse {
  // The terminal delivers Ctrl-C to the whole foreground process group, so the child can die
  // of the interrupt before the parent's own handler has run. That is the user stopping the
  // build, and it is reported as that rather than as a broken file.
  if (signal === 'SIGINT' || signal === 'SIGTERM' || code === WINDOWS_CONTROL_C_EXIT) {
    return { kind: 'interrupted' };
  }
  if (/JavaScript heap out of memory|Reached heap limit/.test(stderr)) {
    return {
      kind: 'excluded',
      code: 'parse-memory',
      message: `Parsing needed more than the ${limits.memoryMb} MB memory ceiling, so the file was left out of the build. Set LORE_PARSE_MEMORY_MB to allow more, or exclude the file in .loreignore.`,
    };
  }
  return {
    kind: 'excluded',
    code: 'parse-crashed',
    message: `The parse process ended unexpectedly (${describeExit(code, signal)}), so the file was left out of the build. The operating system may have stopped it for using too much memory. Exclude the file in .loreignore if this repeats.`,
  };
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`;
}

function seconds(milliseconds: number): string {
  const value = milliseconds / 1000;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} s`;
}
