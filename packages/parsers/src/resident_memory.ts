import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { LoreError } from '@lorepack/core';

export interface ResidentMemoryMonitor {
  readonly ready: Promise<void>;
  readonly state: {
    bytes: number | null;
    exceeded: boolean;
    error: LoreError | null;
  };
  stop(): void;
}

const INTERVAL_MS = 100;
const READER_TIMEOUT_MS = 250;

export function parseMacResidentMemory(report: string): number {
  const value = report.trim();
  if (!/^\d+$/.test(value))
    throw new Error(`macOS did not report parser resident memory: ${JSON.stringify(report)}.`);
  return Number(value) * 1024;
}

export function readMacResidentMemory(reader: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    const output = { stdout: '', stderr: '' };
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reader.kill('SIGKILL');
      reject(error);
    };
    reader.on('error', fail);
    for (const name of ['stdout', 'stderr'] as const) {
      reader[name].setEncoding('utf8');
      reader[name].on('data', (chunk: string) => {
        if (settled) return;
        if (Buffer.byteLength(output[name]) + Buffer.byteLength(chunk) > 256) {
          fail(new Error(`macOS resident-memory ${name} exceeded 256 bytes.`));
          return;
        }
        output[name] += chunk;
      });
    }
    reader.once('close', (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal !== null) {
        fail(
          new Error(
            `macOS resident-memory reader exited (${code ?? signal}). ${JSON.stringify(output.stderr)}`,
          ),
        );
        return;
      }
      try {
        const bytes = parseMacResidentMemory(output.stdout);
        settled = true;
        resolve(bytes);
      } catch (error) {
        fail(error);
      }
    });
  });
}

export async function readLinuxResidentMemory(pid: number): Promise<number | null> {
  let report: string;
  try {
    report = await readFile(`/proc/${pid}/smaps_rollup`, {
      encoding: 'utf8',
      signal: AbortSignal.timeout(READER_TIMEOUT_MS),
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')
      return null;
    throw error;
  }
  const match = /^Rss:\s+(\d+)\s+kB$/m.exec(report);
  if (match === null) throw new Error('Linux did not report parser resident memory.');
  return Number(match[1]) * 1024;
}

export function createStartupWatchdog(
  expired: () => void,
  observe?: (phase: 'arm' | 'fire' | 'check') => void,
) {
  let stopped = false;
  let pending: ReturnType<typeof setImmediate> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = performance.now();
  const arm = (delayMs: number): void => {
    timer = setTimeout(() => {
      observe?.('fire');
      pending = setImmediate(() => {
        observe?.('check');
        if (stopped) return;
        const remaining = 5000 - (performance.now() - startedAt);
        if (remaining > 0) arm(Math.ceil(remaining));
        else expired();
      });
    }, delayMs);
  };
  observe?.('arm');
  arm(5000);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearImmediate(pending);
    },
  };
}

export function createReportingWatchdog(
  expired: (details: { reports: number; silenceMs: number }) => void,
  observe?: (phase: 'arm' | 'fire' | 'check', reports: number) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: ReturnType<typeof setImmediate> | undefined;
  let stopped = false;
  let reports = 0;
  let lastReport = 0;
  const arm = (delayMs: number): void => {
    timer = setTimeout(() => {
      const observedReports = reports;
      observe?.('fire', observedReports);
      pending = setImmediate(() => {
        observe?.('check', reports);
        if (stopped || reports !== observedReports) return;
        const silenceMs = performance.now() - lastReport;
        const remaining = READER_TIMEOUT_MS - silenceMs;
        if (remaining > 0) arm(Math.ceil(remaining));
        else expired({ reports, silenceMs });
      });
    }, delayMs);
  };
  return {
    report() {
      if (stopped) return;
      clearTimeout(timer);
      clearImmediate(pending);
      reports++;
      lastReport = performance.now();
      observe?.('arm', reports);
      arm(READER_TIMEOUT_MS);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearImmediate(pending);
    },
  };
}

export function monitorResidentMemory(
  parser: ChildProcess,
  limitMiB: number,
): ResidentMemoryMonitor {
  const state: ResidentMemoryMonitor['state'] = { bytes: null, exceeded: false, error: null };
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ChildProcess | undefined;
  let reporting: ReturnType<typeof createReportingWatchdog> | undefined;
  let startup: ReturnType<typeof createStartupWatchdog> | undefined;
  const diagnostic =
    process.platform === 'win32' && process.env.LOREPACK_OBSERVER_DIAGNOSTIC === '1';
  const diagnosticStartedAt = performance.now();
  const events: Array<Record<string, string | number>> = [];
  let diagnosticCause: Error | undefined;
  let diagnosticBaseMessage = '';
  let readerCloseObserved = false;
  const traceSnapshot = () => JSON.stringify({ readerCloseObserved, events });
  const refreshTrace = (): void => {
    if (diagnosticCause === undefined) return;
    diagnosticCause.message = `${diagnosticBaseMessage} Observer trace: ${traceSnapshot()}`;
  };
  const record = (event: Record<string, string | number>): void => {
    if (!diagnostic) return;
    if (events.length === 16) events.shift();
    events.push({ ...event, parentMs: Math.round(performance.now() - diagnosticStartedAt) });
    refreshTrace();
  };
  const stop = (): void => {
    stopped = true;
    clearTimeout(timer);
    reporting?.stop();
    startup?.stop();
    reader?.kill('SIGKILL');
  };
  const alive = (): boolean => {
    if (parser.pid === undefined || parser.exitCode !== null || parser.signalCode !== null)
      return false;
    try {
      process.kill(parser.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  const fail = (cause: unknown): void => {
    if (stopped || !alive()) return;
    if (diagnostic && cause instanceof Error) {
      diagnosticBaseMessage = cause.message;
      diagnosticCause = cause;
      refreshTrace();
    }
    const error = new LoreError(
      'LORE_E_PARSE_FAILED',
      'Could not observe parser resident memory.',
      {
        cause: diagnosticCause ?? cause,
        remediation:
          'Restore access to the operating system process memory report before retrying. The parser was stopped.',
      },
    );
    state.error = error;
    stop();
    parser.kill('SIGKILL');
    rejectReady(error);
  };
  const sample = (bytes: number): void => {
    if (stopped) return;
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      fail(new Error('The operating system returned an invalid resident size.'));
      return;
    }
    state.bytes = bytes;
    resolveReady();
    if (process.platform === 'win32') {
      startup?.stop();
      reporting?.report();
    }
    if (bytes > limitMiB * 1024 * 1024) {
      state.exceeded = true;
      stop();
      parser.kill('SIGKILL');
    }
  };
  reporting = createReportingWatchdog(
    ({ reports, silenceMs }) =>
      fail(
        new Error(
          `The process memory observer stopped reporting: ${reports} reports; ${Math.round(silenceMs)} ms since the last; reader ${reader?.pid ?? 'unknown'} (exit ${reader?.exitCode ?? 'none'}, signal ${reader?.signalCode ?? 'none'}); last RSS ${state.bytes ?? 'unknown'} bytes.`,
        ),
      ),
    diagnostic ? (phase, reports) => record({ kind: phase, reports }) : undefined,
  );
  const pid = parser.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    rejectReady(new Error('The parser process did not start.'));
    return { ready, state, stop };
  }

  if (process.platform === 'win32') {
    const systemRoot = Object.entries(process.env).find(
      ([name]) => name.toLowerCase() === 'systemroot',
    )?.[1];
    if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
      fail(new Error('Windows did not provide an absolute SystemRoot.'));
      return { ready, state, stop };
    }
    const command =
      `$ErrorActionPreference='Stop'; ` +
      (diagnostic
        ? `$n=1; $clock=[Diagnostics.Stopwatch]::StartNew(); ` +
          `[Console]::Error.WriteLine('LPS:entry:'+$clock.ElapsedMilliseconds); `
        : '') +
      `$p=[System.Diagnostics.Process]::GetProcessById(${pid}); while($true) { $p.Refresh(); ` +
      (diagnostic
        ? `if($n -eq 1) { [Console]::Error.WriteLine('LPS:refresh:'+$clock.ElapsedMilliseconds); } ` +
          `$rss=$p.WorkingSet64; if($n -eq 1) { ` +
          `[Console]::Error.WriteLine('LPS:rss:'+$clock.ElapsedMilliseconds); ` +
          `[Console]::Error.WriteLine('LPS:before-write:'+$clock.ElapsedMilliseconds); } ` +
          `[Console]::Out.WriteLine($rss); ` +
          `[Console]::Error.WriteLine('LPR:'+$n+':'+$clock.ElapsedMilliseconds); $n++; `
        : '[Console]::Out.WriteLine($p.WorkingSet64); ') +
      `[Threading.Thread]::Sleep(${INTERVAL_MS}) }`;
    const startedAt = performance.now();
    let pending = '';
    let stderr = '';
    let diagnosticPending = '';
    let reports = 0;
    startup = createStartupWatchdog(
      () =>
        fail(
          new Error(
            `The process memory observer did not become ready: ${Math.round(performance.now() - startedAt)} ms; reader ${reader?.pid ?? 'unknown'} (exit ${reader?.exitCode ?? 'none'}, signal ${reader?.signalCode ?? 'none'}); buffered ${pending.length} characters. ${stderr}`,
          ),
        ),
      diagnostic ? (phase) => record({ kind: `startup-${phase}` }) : undefined,
    );
    reader = spawn(
      win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (diagnostic) reader.once('spawn', () => record({ kind: 'spawn' }));
    reader.stdout?.setEncoding('utf8');
    reader.stderr?.setEncoding('utf8');
    reader.stdout?.on('data', (chunk: string) => {
      if (stopped) return;
      pending += chunk;
      if (pending.length > 4096) {
        fail(new Error('The process memory observer exceeded its output limit.'));
        return;
      }
      let newline = pending.indexOf('\n');
      while (newline !== -1 && !stopped) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!/^\d+$/.test(line)) {
          fail(new Error('The process memory observer returned a nonnumeric report.'));
          return;
        }
        if (diagnostic) {
          reports++;
          record({ kind: 'receipt', reports, bytes: Number(line) });
        }
        sample(Number(line));
        newline = pending.indexOf('\n');
      }
    });
    reader.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 1024);
      if (!diagnostic) return;
      diagnosticPending = (diagnosticPending + chunk).slice(-1024);
      let newline = diagnosticPending.indexOf('\n');
      while (newline !== -1) {
        const line = diagnosticPending.slice(0, newline).trim();
        diagnosticPending = diagnosticPending.slice(newline + 1);
        const match = /^LPR:(\d{1,10}):(\d{1,15})$/.exec(line);
        if (match !== null) {
          record({ kind: 'emission', reports: Number(match[1]), readerMs: Number(match[2]) });
        }
        const startupMatch = /^LPS:(entry|refresh|rss|before-write):(\d{1,15})$/.exec(line);
        if (startupMatch !== null) {
          record({
            kind: 'script',
            phase: startupMatch[1] as string,
            readerMs: Number(startupMatch[2]),
          });
        }
        newline = diagnosticPending.indexOf('\n');
      }
    });
    reader.on('error', fail);
    reader.once('close', (code, signal) => {
      if (diagnostic) {
        readerCloseObserved = true;
        record({ kind: 'close', exitCode: code ?? 'none', signal: signal ?? 'none' });
        if (diagnosticCause !== undefined) {
          const line = `LOREPACK_OBSERVER_DIAGNOSTIC_FINAL ${traceSnapshot()}`;
          process.stderr.write(
            `${Buffer.byteLength(line) <= 4096 ? line : 'LOREPACK_OBSERVER_DIAGNOSTIC_FINAL {"truncated":true}'}\n`,
          );
        }
      }
      fail(new Error(`The process memory observer stopped (${code ?? signal}). ${stderr}`));
    });
  } else {
    const read = async (): Promise<number | null> => {
      if (process.platform === 'linux') {
        return readLinuxResidentMemory(pid);
      }
      if (process.platform !== 'darwin') {
        throw new Error(`Resident memory observation is unsupported on ${process.platform}.`);
      }
      // spawn's timeout preserves queued output from a query that already exited.
      const query = spawn('/bin/ps', ['-o', 'rss=', '-p', String(pid)], {
        timeout: READER_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      reader = query;
      try {
        return await readMacResidentMemory(query);
      } finally {
        reader = undefined;
      }
    };
    const poll = async (): Promise<void> => {
      if (stopped) return;
      try {
        const bytes = await read();
        if (bytes === null) {
          stop();
          return;
        }
        sample(bytes);
      } catch (error) {
        fail(error);
      }
      if (!stopped && alive()) timer = setTimeout(() => void poll(), INTERVAL_MS);
    };
    void poll();
  }
  return { ready, state, stop };
}
