import { type ChildProcess, execFile, spawn } from 'node:child_process';
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

export function createStartupWatchdog(expired: () => void) {
  let stopped = false;
  let pending: ReturnType<typeof setImmediate> | undefined;
  const timer = setTimeout(() => {
    pending = setImmediate(() => {
      if (!stopped) expired();
    });
  }, 5000);
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
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: ReturnType<typeof setImmediate> | undefined;
  let stopped = false;
  let reports = 0;
  let lastReport = 0;
  return {
    report() {
      if (stopped) return;
      clearTimeout(timer);
      clearImmediate(pending);
      reports++;
      lastReport = performance.now();
      timer = setTimeout(() => {
        const observedReports = reports;
        pending = setImmediate(() => {
          if (!stopped && reports === observedReports)
            expired({ reports, silenceMs: performance.now() - lastReport });
        });
      }, READER_TIMEOUT_MS);
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
    const error = new LoreError(
      'LORE_E_PARSE_FAILED',
      'Could not observe parser resident memory.',
      {
        cause,
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
  reporting = createReportingWatchdog(({ reports, silenceMs }) =>
    fail(
      new Error(
        `The process memory observer stopped reporting: ${reports} reports; ${Math.round(silenceMs)} ms since the last; reader ${reader?.pid ?? 'unknown'} (exit ${reader?.exitCode ?? 'none'}, signal ${reader?.signalCode ?? 'none'}); last RSS ${state.bytes ?? 'unknown'} bytes.`,
      ),
    ),
  );
  const pid = parser.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    rejectReady(new Error('The parser process did not start.'));
    return { ready, state, stop };
  }

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
      fail(new Error('Windows did not provide an absolute SystemRoot.'));
      return { ready, state, stop };
    }
    const command =
      `$ErrorActionPreference='Stop'; $p=[System.Diagnostics.Process]::GetProcessById(${pid}); ` +
      `while($true) { $p.Refresh(); [Console]::Out.WriteLine($p.WorkingSet64); ` +
      `[Threading.Thread]::Sleep(${INTERVAL_MS}) }`;
    const startedAt = performance.now();
    let pending = '';
    let stderr = '';
    startup = createStartupWatchdog(() =>
      fail(
        new Error(
          `The process memory observer did not become ready: ${Math.round(performance.now() - startedAt)} ms; reader ${reader?.pid ?? 'unknown'} (exit ${reader?.exitCode ?? 'none'}, signal ${reader?.signalCode ?? 'none'}); buffered ${pending.length} characters. ${stderr}`,
        ),
      ),
    );
    reader = spawn(
      win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
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
        sample(Number(line));
        newline = pending.indexOf('\n');
      }
    });
    reader.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 1024);
    });
    reader.on('error', fail);
    reader.once('close', (code, signal) => {
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
      const report = await new Promise<string>((resolve, reject) => {
        reader = execFile(
          '/bin/ps',
          ['-o', 'rss=', '-p', String(pid)],
          { encoding: 'utf8', maxBuffer: 256, timeout: READER_TIMEOUT_MS, killSignal: 'SIGKILL' },
          (error, stdout) => {
            reader = undefined;
            if (error !== null) reject(error);
            else resolve(stdout);
          },
        );
      });
      return parseMacResidentMemory(report);
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
