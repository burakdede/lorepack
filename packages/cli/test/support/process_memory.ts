import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

interface ProcessRow {
  pid: number;
  parent: number;
  rssBytes: number;
  command: string;
}

const execute = promisify(execFile);

// Independent OS snapshots: this deliberately imports no production RSS observer code.
async function snapshots(receive: (rows: ProcessRow[]) => void): Promise<() => Promise<void>> {
  if (process.platform !== 'win32') {
    let stopped = false;
    let failure: unknown;
    let pending: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,rss=,args='], {
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 4 * 1024 * 1024,
      });
      receive(
        stdout
          .trim()
          .split('\n')
          .map((line) => {
            const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
            if (match === null) throw new Error(`Invalid process snapshot: ${line}`);
            return {
              pid: Number(match[1]),
              parent: Number(match[2]),
              rssBytes: Number(match[3]) * 1024,
              command: match[4] ?? '',
            };
          }),
      );
      if (!stopped)
        timer = setTimeout(() => {
          pending = poll().catch((error: unknown) => {
            failure = error;
          });
        }, 100);
    };
    await poll();
    return async () => {
      stopped = true;
      clearTimeout(timer);
      await pending;
      if (failure !== undefined) throw failure;
    };
  }

  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || !win32.isAbsolute(systemRoot))
    throw new Error('The independent observer requires an absolute SystemRoot.');
  const command =
    "$ErrorActionPreference='Stop'; while($true) { " +
    '$rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine); ' +
    'ConvertTo-Json -Compress -InputObject $rows; Start-Sleep -Milliseconds 100 }';
  const child = spawn(
    win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const closed = once(child, 'close');
  let pending = '';
  let stderr = '';
  let failure: unknown;
  let stopping = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.on('error', (error) => {
    failure = error;
    rejectReady(error);
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(0, 4096);
  });
  child.stdout.on('data', (chunk: string) => {
    try {
      pending += chunk;
      if (pending.length > 4 * 1024 * 1024)
        throw new Error('Independent process report is too large.');
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const data: unknown = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (!Array.isArray(data)) throw new Error('Expected a Windows process array.');
        receive(
          data.map((row) => ({
            pid: Number(row.ProcessId),
            parent: Number(row.ParentProcessId),
            rssBytes: Number(row.WorkingSetSize),
            command: String(row.CommandLine ?? ''),
          })),
        );
        resolveReady();
        newline = pending.indexOf('\n');
      }
    } catch (error) {
      failure = error;
      rejectReady(error);
      child.kill('SIGKILL');
    }
  });
  child.once('exit', (code) => {
    if (!stopping) {
      failure = new Error(`Independent Windows observer exited ${code}: ${stderr}`);
      rejectReady(failure);
    }
  });
  const deadline = setTimeout(
    () => rejectReady(new Error('Independent observer did not start.')),
    15_000,
  );
  try {
    await ready;
  } catch (error) {
    stopping = true;
    child.kill('SIGKILL');
    await closed.catch(() => {});
    throw error;
  } finally {
    clearTimeout(deadline);
  }
  return async () => {
    stopping = true;
    child.kill('SIGKILL');
    await closed;
    if (failure !== undefined) throw failure;
  };
}

export async function measureCliMemory(args: readonly string[], env: NodeJS.ProcessEnv) {
  let child: ChildProcess | undefined;
  const owned = new Set<number>();
  const parserPids = new Set<number>();
  const samples: {
    elapsedMs: number;
    processes: { pid: number; parent: number; rssBytes: number; role: string }[];
  }[] = [];
  let started = 0;
  const stop = await snapshots((rows) => {
    if (child?.pid === undefined) return;
    owned.add(child.pid);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (owned.has(row.parent) && !owned.has(row.pid)) {
          owned.add(row.pid);
          changed = true;
        }
      }
    }
    const selected = rows.filter((row) => owned.has(row.pid));
    for (const row of selected) {
      if (!Number.isSafeInteger(row.rssBytes) || row.rssBytes < 0)
        throw new Error('Independent observer returned invalid resident memory.');
      if (/parse-child\.js(?:"|\s|$)/.test(row.command)) parserPids.add(row.pid);
    }
    samples.push({
      elapsedMs: performance.now() - started,
      processes: selected.map((row) => ({
        pid: row.pid,
        parent: row.parent,
        rssBytes: row.rssBytes,
        role: row.pid === child?.pid ? 'cli' : parserPids.has(row.pid) ? 'parser' : 'observer',
      })),
    });
  });
  let stdout = '';
  let stderr = '';
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let observerError: string | null = null;
  const finish = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await stop();
    } catch (error) {
      observerError = String(error);
    }
  };
  try {
    started = performance.now();
    child = spawn(process.execPath, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    deadline = setTimeout(() => child?.kill('SIGKILL'), 45_000);
    const [code, signal] = await once(child, 'close');
    await finish();
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
    };
    for (let attempt = 0; attempt < 10 && [...owned].some(alive); attempt++) await delay(100);
    const remainingPids = [...owned].filter(alive);
    return {
      code,
      signal,
      stdout,
      stderr,
      durationMs: performance.now() - started,
      samples,
      parserPids: [...parserPids],
      remainingPids,
      observerError,
    };
  } finally {
    clearTimeout(deadline);
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finish();
    for (const pid of owned) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          console.error('Could not stop an owned memory-fixture process.', { pid, error });
      }
    }
  }
}
