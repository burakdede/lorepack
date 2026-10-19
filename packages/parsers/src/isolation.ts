import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  type ArtifactParser,
  LoreError,
  type ParsedArtifact,
  type ParseInput,
} from '@lorepack/core';
import { type ChildReply, deserializeError } from './isolation-protocol.js';
import {
  createLinuxResidentReader,
  type LinuxReaderFactory,
  readLinuxProcessBirthSync,
} from './linux_resident_reader.js';
import { PARSERS } from './registry-parsers.js';
import { monitorResidentMemory, type ResidentMemoryMonitor } from './resident_memory.js';

/**
 * Runs each parse in a child with a deadline, heap ceiling and sampled RSS threshold.
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
  /** Sampled resident-memory threshold in MiB; allocations can overshoot between samples. */
  readonly residentMemoryMb?: number;
}

export const PARSE_LIMITS = {
  defaults: { timeoutMs: 30_000, memoryMb: 2048, residentMemoryMb: 1024 },
  timeoutMs: { min: 100, max: 3_600_000 },
  memoryMb: { min: 64, max: 32_768 },
  residentMemoryMb: { min: 64, max: 32_768 },
} as const;

export type ParseExclusionCode =
  | 'parse-timeout'
  | 'parse-memory'
  | 'parse-crashed'
  | 'nesting-too-deep';

export type IsolatedParse =
  | { readonly kind: 'parsed'; readonly result: ParsedArtifact }
  | { readonly kind: 'excluded'; readonly code: ParseExclusionCode; readonly message: string }
  | { readonly kind: 'interrupted' };

/**
 * A document nested deeper than a parser can recurse (#595): a few kilobytes of `>` or
 * `<span>` overflow the stack in remark, in `hast-util-from-parse5`, or in our own walkers.
 *
 * The bytes are valid and the parser is not broken; the document is past a limit, the same as
 * one that takes too long. So it is left out with a warning, and the rest of the project still
 * builds, instead of the whole build failing as `LORE_E_PARSE_FAILED` until someone finds the
 * file. Only the stack overflow qualifies: any other `RangeError` is a parser bug and still
 * fails the build.
 */
const NESTING_TOO_DEEP: IsolatedParse = {
  kind: 'excluded',
  code: 'nesting-too-deep',
  message:
    'The document is nested more deeply than its parser can follow, so the file was left out of the build. Reduce the nesting, or exclude the file in .loreignore.',
};

/** Cause chains are short; the bound only stops a cyclic one. */
const MAX_CAUSE_DEPTH = 8;

/**
 * True when the error, or anything it wraps, is V8's stack overflow. Checked through the
 * cause chain because a parser may wrap it (DOCX reports `LORE_E_PARSE_FAILED` with the
 * overflow as its cause), and by name because an error rebuilt from the child is a plain
 * `Error` carrying the original name.
 */
function overflowedStack(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current.name === 'RangeError' && /Maximum call stack size exceeded/.test(current.message))
      return true;
    current = current.cause;
  }
  return false;
}

/** How much of the child's stderr is kept. V8 prints its fatal line first, the stack after. */
const STDERR_HEAD_BYTES = 16 * 1024;

/** Windows reports a console interrupt as this exit status rather than as a signal. */
const WINDOWS_CONTROL_C_EXIT = 0xc000013a;

interface Child {
  readonly process: ChildProcess;
  readonly stderr: { head: string };
  /** Settles when the child has exited and its stderr has drained. */
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly memory: ResidentMemoryMonitor;
  used: boolean;
}

export class ParserHost {
  readonly #limits: ParseLimits;
  readonly #residentMemoryMb: number;
  #child: Promise<Child> | null = null;
  readonly #children = new Set<Child>();

  constructor(limits: ParseLimits = PARSE_LIMITS.defaults) {
    this.#limits = limits;
    this.#residentMemoryMb = limits.residentMemoryMb ?? PARSE_LIMITS.defaults.residentMemoryMb;
    if (
      !Number.isInteger(this.#residentMemoryMb) ||
      this.#residentMemoryMb < PARSE_LIMITS.residentMemoryMb.min ||
      this.#residentMemoryMb > PARSE_LIMITS.residentMemoryMb.max
    ) {
      throw new LoreError('LORE_E_INVALID_ARGUMENT', 'Invalid parser resident memory budget.', {
        remediation: 'Use an integer from 64 to 32768 MiB for residentMemoryMb.',
      });
    }
  }

  async parse(
    parser: ArtifactParser,
    input: ParseInput,
    signal?: AbortSignal,
  ): Promise<IsolatedParse> {
    if (!PARSERS.includes(parser)) {
      try {
        return { kind: 'parsed', result: await parser.parse(input) };
      } catch (error) {
        if (overflowedStack(error)) return NESTING_TOO_DEEP;
        throw error;
      }
    }
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
        void child.memory.settle().then(() => {
          if (settled) return;
          if (child.memory.state.exceeded || child.memory.state.error !== null) return;
          if (reply.kind === 'parsed')
            finish(() => resolve({ kind: 'parsed', result: reply.result }));
          else if (reply.kind === 'failed') {
            const error = deserializeError(reply.error);
            finish(() => (overflowedStack(error) ? resolve(NESTING_TOO_DEEP) : reject(error)));
          }
        });
      };
      child.process.on('message', onMessage);

      void child.closed.then(async ({ code, signal: exitSignal }) => {
        await child.memory.settle();
        if (settled) return;
        this.#child = null;
        if (child.memory.state.error !== null) {
          finish(() => reject(child.memory.state.error));
          return;
        }
        if (child.memory.state.exceeded) {
          finish(() =>
            resolve({
              kind: 'excluded',
              code: 'parse-memory',
              message: `Parsing used more than the ${this.#residentMemoryMb} MiB resident memory budget, so the file was left out of the build. Set LORE_PARSE_RSS_MB to allow more, or exclude the file in .loreignore.`,
            }),
          );
          return;
        }
        finish(() => resolve(classifyExit(code, exitSignal, child.stderr.head, this.#limits)));
      });

      child.used = true;
      if (child.process.connected) child.process.send({ parserId: parser.id, input });
    });
  }

  /** Ends the child. Safe to call more than once, and with no child started. */
  close(): void {
    this.#child = null;
    for (const child of this.#children) {
      child.memory.stop();
      child.process.kill('SIGKILL');
    }
  }

  async closeAndWait(): Promise<void> {
    const children = [...this.#children];
    this.close();
    await Promise.all(
      children.map(async (child) => {
        await child.closed;
        await child.memory.closed;
        if (child.memory.state.error !== null) throw child.memory.state.error;
      }),
    );
  }

  #ready(): Promise<Child> {
    if (this.#child === null) {
      const pending = start(this.#limits, this.#residentMemoryMb, (child) => {
        this.#children.add(child);
        void child.closed
          .then(async () => {
            await child.memory.closed;
            this.#children.delete(child);
          })
          .catch(() => undefined);
      });
      this.#child = pending;
      void pending.then(
        (child) => {
          void child.closed.then(() => {
            if (this.#child === pending) this.#child = null;
          });
        },
        () => {
          if (this.#child === pending) this.#child = null;
        },
      );
    }
    const pending = this.#child;
    return pending.then(async (child) => {
      await child.memory.settle();
      if (
        child.used &&
        (child.memory.state.exceeded ||
          child.memory.state.error !== null ||
          !child.process.connected)
      ) {
        if (this.#child === pending) this.#child = null;
        return this.#ready();
      }
      return child;
    });
  }
}

function start(
  limits: ParseLimits,
  residentMemoryMb: number,
  started?: (child: Child) => void,
): Promise<Child> {
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
  let linuxFactory: LinuxReaderFactory | undefined;
  if (process.platform === 'linux' && child.pid !== undefined) {
    try {
      const expectedBirth = readLinuxProcessBirthSync(child.pid);
      linuxFactory = (pid, limit, callbacks) =>
        createLinuxResidentReader(
          pid,
          limit,
          callbacks,
          new URL('./linux_resident_reader_worker.js', import.meta.url),
          expectedBirth,
        );
    } catch (cause) {
      linuxFactory = () => {
        throw cause;
      };
    }
  }
  const memory = monitorResidentMemory(child, residentMemoryMb, linuxFactory);
  const result: Child = { process: child, stderr, closed, memory, used: false };
  started?.(result);
  // closeAndWait observes teardown failures through memory.closed.
  void closed
    .then(async () => {
      await memory.settle();
      memory.stop();
      await memory.closed;
    })
    .catch(() => undefined);

  return new Promise<Child>((resolve, reject) => {
    let parserReady = false;
    let memoryReady = false;
    let completing = false;
    const complete = (): void => {
      if (!parserReady || !memoryReady || completing) return;
      completing = true;
      void memory.settle().then(() => {
        if (memory.state.error !== null) reject(memory.state.error);
        else resolve(result);
      });
    };
    void memory.ready.then(() => {
      memoryReady = true;
      complete();
    }, reject);
    const onMessage = (reply: ChildReply): void => {
      if (reply.kind !== 'ready') return;
      child.off('message', onMessage);
      parserReady = true;
      complete();
    };
    child.on('message', onMessage);
    // Kept for the child's whole life: an `error` event with no listener would throw in the
    // parent. A failed send to a child that died is answered by `close` below, not here.
    child.on('error', reject);
    void closed.then(async ({ code, signal }) => {
      await memory.settle();
      if (memory.state.exceeded) {
        resolve(result);
        return;
      }
      reject(
        memory.state.error ??
          new Error(
            `The parse process exited before it was ready (${describeExit(code, signal)}). ${stderr.head.split('\n')[0] ?? ''}`.trim(),
          ),
      );
    });
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
