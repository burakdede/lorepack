import { closeSync, openSync, readSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  MessageChannel,
  type MessagePort,
  receiveMessageOnPort,
  Worker,
} from 'node:worker_threads';
import { deserializeError, type SerializedError } from './isolation-protocol.js';
import {
  createReportingWatchdog,
  createStartupWatchdog,
  readLinuxResidentMemory,
} from './resident_memory.js';

export const LINUX_READER_SHARED_BYTES = 32;
export interface LinuxReaderCallbacks {
  sample(bytes: number, terminal?: boolean): void;
  error(cause: unknown, terminal?: boolean): void;
  gone(reason?: 'identity-mismatch'): void;
}
export interface LinuxReader {
  settle(): Promise<void>;
  stop(): void;
  readonly closed: Promise<void>;
}
export type LinuxReaderFactory = (
  pid: number,
  limitMiB: number,
  callbacks: LinuxReaderCallbacks,
) => LinuxReader;
export interface LinuxReaderData {
  readonly role: 'lorepack-linux-resident-reader';
  readonly pid: number;
  readonly expectedBirth: string;
  readonly limitMiB: number;
  readonly generation: number;
  readonly shared: SharedArrayBuffer;
  readonly port: MessagePort;
}
export type LinuxReaderPayload =
  | { readonly kind: 'ready' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'sample' }
  | { readonly kind: 'terminal'; readonly error?: SerializedError }
  | { readonly kind: 'barrier'; readonly id: number };
export type LinuxReaderMessage = LinuxReaderPayload & { readonly generation: number };
export type LinuxReaderRequest =
  | { readonly kind: 'barrier'; readonly generation: number; readonly id: number }
  | { readonly kind: 'stop'; readonly generation: number };

function birthFromStat(pid: number, stat: string): string {
  const birth = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
  if (birth === undefined || !/^\d{1,20}$/.test(birth))
    throw new Error('Linux did not report a valid process birth identity.');
  return `${pid}:${birth}`;
}

export function readLinuxProcessBirthSync(pid: number): string {
  const descriptor = openSync(`/proc/${pid}/stat`, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length === buffer.length)
      throw new Error('Linux process identity exceeded its read bound.');
    return birthFromStat(pid, buffer.toString('utf8', 0, length));
  } finally {
    closeSync(descriptor);
  }
}

export function pollLinuxResidentMemory(
  pid: number,
  callbacks: LinuxReaderCallbacks,
  expectedBirth?: string,
): LinuxReader {
  let stopped = false;
  let sampled = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    if (!pending) resolveClosed();
  };
  const poll = async () => {
    if (stopped) return;
    pending = true;
    const startedAt = performance.now();
    try {
      const signal = AbortSignal.timeout(250);
      const sameBirth = async () =>
        expectedBirth === undefined ||
        birthFromStat(pid, await readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal })) ===
          expectedBirth;
      const sameBefore = await sameBirth();
      if (stopped) return;
      if (!sameBefore) {
        callbacks.gone('identity-mismatch');
        stop();
        return;
      }
      const bytes = await readLinuxResidentMemory(pid, signal);
      if (stopped) return;
      const sameAfter = await sameBirth();
      if (stopped) return;
      if (!sameAfter) {
        callbacks.gone('identity-mismatch');
        stop();
        return;
      }
      if (bytes === null) {
        callbacks.gone();
        stop();
        return;
      }
      callbacks.sample(bytes);
      sampled = true;
    } catch (cause) {
      if (stopped) return;
      if (
        expectedBirth !== undefined &&
        cause !== null &&
        typeof cause === 'object' &&
        'code' in cause &&
        (cause.code === 'ENOENT' || cause.code === 'ESRCH')
      ) {
        callbacks.gone();
        stop();
        return;
      }
      const names =
        cause instanceof Error
          ? [cause.cause instanceof Error ? cause.cause.name : null, cause.name]
          : [];
      const context = {
        platform: 'linux',
        samplePhase: sampled ? 'subsequent' : 'initial',
        elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        readerPid: null,
        exitCode: null,
        signalCode: null,
        localKillRequested: null,
        abortReason: names.find((name) => name === 'TimeoutError' || name === 'AbortError') ?? null,
      };
      callbacks.error(
        new Error(`POSIX resident-memory read context: ${JSON.stringify(context)}`, { cause }),
      );
      stop();
    } finally {
      pending = false;
      if (stopped) resolveClosed();
      else
        timer = setTimeout(() => {
          void poll();
        }, 100);
    }
  };
  void poll();
  return { settle: async () => {}, stop, closed };
}

let generation = 0;
export function createLinuxResidentReader(
  pid: number,
  limitMiB: number,
  callbacks: LinuxReaderCallbacks,
  entry = new URL('./linux_resident_reader_worker.js', import.meta.url),
  expectedBirth = readLinuxProcessBirthSync(pid),
): LinuxReader {
  const current = ++generation;
  if (!Number.isSafeInteger(current)) throw new Error('Linux reader generation exhausted.');
  const shared = new SharedArrayBuffer(LINUX_READER_SHARED_BYTES);
  const state = new BigInt64Array(shared);
  const { port1, port2 } = new MessageChannel();
  let worker: Worker;
  try {
    worker = new Worker(entry, {
      execArgv: [],
      workerData: {
        role: 'lorepack-linux-resident-reader',
        pid,
        expectedBirth,
        limitMiB,
        generation: current,
        shared,
        port: port2,
      } satisfies LinuxReaderData,
      transferList: [port2],
    });
  } catch (error) {
    port1.close();
    port2.close();
    throw error;
  }
  let stopped = false;
  let exited = false;
  let terminating = false;
  let shutdown = false;
  let shutdownPhase = 0;
  let shutdownWatchdog: ReturnType<typeof createReportingWatchdog> | undefined;
  let terminalReceived = false;
  let startupSettled = false;
  let servicing = false;
  let resolveStartup: () => void = () => {};
  const startup = new Promise<void>((resolve) => {
    resolveStartup = resolve;
  });
  const startupWatchdog = createStartupWatchdog(() => {
    drain();
    if (!startupSettled)
      fail(new Error('Linux resident-memory reader did not become ready within 5000 ms.'));
  });
  const finishStartup = () => {
    if (startupSettled) return;
    startupSettled = true;
    startupWatchdog.stop();
    resolveStartup();
  };
  let barrier = 0;
  let pending:
    | {
        id: number;
        promise: Promise<void>;
        resolve: () => void;
        started: number;
        timer?: ReturnType<typeof setTimeout>;
        check?: ReturnType<typeof setImmediate>;
      }
    | undefined;
  let resolveClosed: () => void = () => {};
  let rejectClosed: (cause: unknown) => void = () => {};
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => undefined);
  const terminate = () => {
    if (terminating || exited) return;
    terminating = true;
    finishStartup();
    shutdownWatchdog?.stop();
    port1.close();
    void worker.terminate().catch((cause: unknown) => {
      callbacks.error(
        new Error('Could not terminate the Linux resident-memory reader.', { cause }),
        true,
      );
      rejectClosed(cause);
    });
  };
  const complete = () => {
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    clearImmediate(pending.check);
    pending.resolve();
    pending = undefined;
  };
  const handle = (message: LinuxReaderMessage) => {
    if (message.generation !== current || terminating) return;
    if (message.kind === 'ready') {
      servicing = true;
      finishStartup();
      return;
    }
    if (message.kind === 'closed') {
      shutdownPhase++;
      shutdownWatchdog?.report();
      return;
    }
    if (message.kind === 'terminal') {
      terminalReceived = true;
      const terminal = Atomics.load(state, 2);
      if (message.error !== undefined) callbacks.error(deserializeError(message.error), true);
      else if (terminal === 2n) callbacks.sample(Number(Atomics.load(state, 0)), true);
      else callbacks.gone(terminal === 4n ? 'identity-mismatch' : undefined);
      complete();
      if (stopped) cooperativeStop();
    } else if (message.kind === 'sample') {
      Atomics.store(state, 3, 0n);
      if (!stopped && Atomics.load(state, 2) === 0n)
        callbacks.sample(Number(Atomics.load(state, 0)));
    } else if (pending?.id === message.id && (Atomics.load(state, 2) === 0n || terminalReceived))
      complete();
  };
  const drain = () => {
    if (terminating) return;
    let received = receiveMessageOnPort(port1);
    while (received !== undefined) {
      handle(received.message as LinuxReaderMessage);
      if (terminating) break;
      received = receiveMessageOnPort(port1);
    }
  };
  const cooperativeStop = () => {
    if (shutdown || terminating || exited) return;
    shutdown = true;
    shutdownWatchdog = createReportingWatchdog(() => {
      const phase = shutdownPhase;
      drain();
      if (phase !== shutdownPhase || terminating || exited) return;
      callbacks.error(
        new Error('Linux resident-memory reader did not finish stopping within 250 ms.'),
        true,
      );
      terminate();
    });
    shutdownWatchdog.report();
    port1.postMessage({ kind: 'stop', generation: current } satisfies LinuxReaderRequest);
  };
  const settle = (): Promise<void> => {
    if (terminating || exited) return Promise.resolve();
    drain();
    if (terminating || terminalReceived) return Promise.resolve();
    if (!startupSettled) return startup.then(settle);
    if (!servicing) return Promise.resolve();
    if (pending !== undefined) return pending.promise;
    const id = ++barrier;
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    pending = { id, promise, resolve, started: performance.now() };
    const arm = (delayMs: number) => {
      if (pending?.id !== id) return;
      pending.timer = setTimeout(() => {
        if (pending?.id !== id) return;
        pending.check = setImmediate(() => {
          drain();
          if (pending?.id !== id) return;
          const remaining = 250 - (performance.now() - pending.started);
          if (remaining > 0) arm(Math.ceil(remaining));
          else fail(new Error('Linux resident-memory reader stopped responding for 250 ms.'));
        });
      }, delayMs);
    };
    arm(250);
    port1.postMessage({ kind: 'barrier', generation: current, id } satisfies LinuxReaderRequest);
    return promise;
  };
  const fail = (cause: unknown) => {
    finishStartup();
    drain();
    const terminal = Atomics.load(state, 2);
    if ((!stopped || terminal !== 0n) && !terminalReceived) {
      terminalReceived = true;
      if (terminal === 2n) callbacks.sample(Number(Atomics.load(state, 0)), true);
      else if (terminal === 3n || terminal === 4n)
        callbacks.gone(terminal === 4n ? 'identity-mismatch' : undefined);
      else callbacks.error(cause, true);
    }
    complete();
    terminate();
  };
  port1.on('message', handle);
  worker.once('error', fail);
  worker.once('exit', (code) => {
    exited = true;
    if (!terminating) drain();
    if (!terminalReceived && (!stopped || Atomics.load(state, 2) !== 0n))
      fail(
        new Error(
          `Linux resident-memory reader exited (${code}) before terminal detail was received.`,
        ),
      );
    complete();
    shutdownWatchdog?.stop();
    finishStartup();
    resolveClosed();
  });
  void settle();
  return {
    settle,
    closed,
    stop() {
      if (stopped) return;
      stopped = true;
      drain();
      if (Atomics.load(state, 2) !== 0n && !terminalReceived) void settle().then(cooperativeStop);
      else {
        complete();
        cooperativeStop();
      }
    },
  };
}
