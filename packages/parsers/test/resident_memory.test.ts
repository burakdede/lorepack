import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { setTimeout as delay, setImmediate as nextCheckPhase } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { ParseInput } from '@lorepack/core';
import { sha256Hex } from '@lorepack/core';
import { markdownParser, ParserHost, pdfParser } from '@lorepack/parsers';
import { cmapBombPdf } from '@lorepack/test-support';
import { afterEach, expect, it, vi } from 'vitest';
import { createLinuxResidentReader } from '../src/linux_resident_reader.js';
import {
  createReportingWatchdog,
  createStartupWatchdog,
  monitorResidentMemory as monitorWithFactory,
  type ResidentMemoryMonitor,
} from '../src/resident_memory.js';

const monitorResidentMemory: typeof monitorWithFactory = (parser, limit) =>
  monitorWithFactory(parser, limit, (pid, limitMiB, callbacks) =>
    createLinuxResidentReader(
      pid,
      limitMiB,
      callbacks,
      new URL('../dist/linux_resident_reader_worker.js', import.meta.url),
    ),
  );

const processes: { child: ChildProcess; closed: Promise<unknown> }[] = [];
const monitors: ResidentMemoryMonitor[] = [];

function manualWatchdogClock() {
  let nowMs = 0;
  const timeouts: Array<{ callback: () => void; handle: NodeJS.Timeout }> = [];
  const immediates: Array<{ callback: () => void; handle: NodeJS.Immediate }> = [];
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
    const handle = {} as NodeJS.Timeout;
    timeouts.push({ callback: callback as () => void, handle });
    return handle;
  });
  const immediate = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
    const handle = {} as NodeJS.Immediate;
    immediates.push({ callback: callback as () => void, handle });
    return handle;
  });
  const clearTimeout = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
    const index = timeouts.findIndex((entry) => entry.handle === handle);
    if (index !== -1) timeouts.splice(index, 1);
  });
  const clearImmediate = vi.spyOn(globalThis, 'clearImmediate').mockImplementation((handle) => {
    const index = immediates.findIndex((entry) => entry.handle === handle);
    if (index !== -1) immediates.splice(index, 1);
  });
  return {
    at(ms: number) {
      nowMs = ms;
    },
    fireTimer() {
      const callback = timeouts.shift()?.callback;
      expect(callback).toBeDefined();
      callback?.();
    },
    fireCheck() {
      const callback = immediates.shift()?.callback;
      expect(callback).toBeDefined();
      callback?.();
    },
    pendingTimers() {
      return timeouts.length;
    },
    restore() {
      clearImmediate.mockRestore();
      clearTimeout.mockRestore();
      immediate.mockRestore();
      timeout.mockRestore();
      clock.mockRestore();
    },
  };
}

it('keeps a reporting watchdog armed until actual 250 ms silence', () => {
  const clock = manualWatchdogClock();
  const expired: number[] = [];
  const watchdog = createReportingWatchdog(({ silenceMs }) => expired.push(silenceMs));
  try {
    watchdog.report();
    clock.at(249.95);
    clock.fireTimer();
    clock.fireCheck();
    expect(expired).toEqual([]);
    expect(clock.pendingTimers()).toBe(1);
    clock.at(250);
    clock.fireTimer();
    clock.fireCheck();
    expect(expired).toEqual([250]);
  } finally {
    watchdog.stop();
    clock.restore();
  }
});

it('keeps a startup watchdog armed until actual 15000 ms silence', () => {
  const clock = manualWatchdogClock();
  const expired: number[] = [];
  const watchdog = createStartupWatchdog(() => expired.push(performance.now()));
  try {
    clock.at(14999.95);
    clock.fireTimer();
    clock.fireCheck();
    expect(expired).toEqual([]);
    expect(clock.pendingTimers()).toBe(1);
    clock.at(15000);
    clock.fireTimer();
    clock.fireCheck();
    expect(expired).toEqual([15000]);
  } finally {
    watchdog.stop();
    clock.restore();
  }
});

it('cancels a pending remainder on a new report and after stop', () => {
  const clock = manualWatchdogClock();
  const expired: number[] = [];
  const watchdog = createReportingWatchdog(({ silenceMs }) => expired.push(silenceMs));
  try {
    watchdog.report();
    clock.at(249.95);
    clock.fireTimer();
    clock.fireCheck();
    expect(clock.pendingTimers()).toBe(1);
    watchdog.report();
    expect(clock.pendingTimers()).toBe(1);
    clock.at(499.9);
    clock.fireTimer();
    clock.fireCheck();
    expect(expired).toEqual([]);
    watchdog.stop();
    watchdog.report();
    expect(clock.pendingTimers()).toBe(0);
    expect(expired).toEqual([]);
  } finally {
    watchdog.stop();
    clock.restore();
  }
});

it('services a pending first observer report before a short startup deadline', async () => {
  const startedAt = Date.now();
  let expired = false;
  const startup = createStartupWatchdog(
    () => {
      expired = true;
    },
    undefined,
    5000,
  );
  const child = spawn(
    process.execPath,
    ['-e', "process.stdout.write(String(Date.now()) + '\\n'); setInterval(() => {}, 1000)"],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  processes.push({ child, closed: once(child, 'close') });
  let report = '';
  child.stdout.on('data', (chunk: Buffer) => {
    report += chunk.toString('utf8');
    if (report.includes('\n')) startup.stop();
  });
  try {
    const until = performance.now() + 5500;
    while (performance.now() < until) {}
    await delay(100);
    expect(Number(report.trim())).toBeGreaterThan(0);
    expect(Number(report.trim())).toBeLessThanOrEqual(startedAt + 5000);
    expect(expired).toBe(false);
    expect(child.exitCode).toBeNull();
  } finally {
    startup.stop();
  }
}, 15_000);

it('rejects an observer with no first report at a short startup deadline', async () => {
  let expired = false;
  const startup = createStartupWatchdog(
    () => {
      expired = true;
    },
    undefined,
    5000,
  );
  try {
    await delay(100);
    expect(expired).toBe(false);
    await delay(5000);
    await nextCheckPhase();
    expect(expired).toBe(true);
  } finally {
    startup.stop();
  }
}, 15_000);

it('services pending OS reports after a parent stall before declaring the observer stale', async () => {
  const child = spawn(
    process.execPath,
    ['-e', "setInterval(() => process.stdout.write('1\\n'), 100)"],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  processes.push({ child, closed: once(child, 'close') });
  let expired = false;
  const watchdog = createReportingWatchdog(() => {
    expired = true;
  });
  try {
    child.stdout.on('data', () => watchdog.report());
    await once(child.stdout, 'data');
    const until = performance.now() + 1000;
    while (performance.now() < until) {}
    await delay(100);
    expect(expired).toBe(false);
    expect(child.exitCode).toBeNull();
  } finally {
    watchdog.stop();
  }
}, 10_000);

async function assertSilentObserver(stallMs: number) {
  const reports: { reports: number; silenceMs: number }[] = [];
  const watchdog = createReportingWatchdog((value) => {
    reports.push(value);
  });
  try {
    watchdog.report();
    const observation = delay(350);
    const until = performance.now() + stallMs;
    while (performance.now() < until) {}
    await observation;
    await nextCheckPhase();
    expect(reports).toEqual([
      expect.objectContaining({ reports: 1, silenceMs: expect.any(Number) }),
    ]);
    expect(reports[0]?.silenceMs).toBeGreaterThanOrEqual(250);
  } finally {
    watchdog.stop();
  }
}

it('still rejects an observer that genuinely stops reporting at the original deadline', async () => {
  await assertSilentObserver(0);
});

it('observes a silent reader after a parent stall and the pending check phase', async () => {
  await assertSilentObserver(500);
});

it('stops the reporting watchdog without arming it again from late data', async () => {
  let expired = false;
  const watchdog = createReportingWatchdog(() => {
    expired = true;
  });
  watchdog.report();
  watchdog.stop();
  watchdog.stop();
  watchdog.report();
  await delay(350);
  expect(expired).toBe(false);
});

function waitingProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const closed = once(child, 'close');
  processes.push({ child, closed });
  return { child, closed };
}

afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  await Promise.all(
    processes.splice(0).map(async ({ child, closed }) => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }),
  );
});

it('stops native resident growth outside a blocked parser, issue677', async () => {
  const bytes = cmapBombPdf(8);
  const input: ParseInput = {
    artifactId: 'memory:docs/cmap.pdf',
    sourceId: 'memory',
    relativePath: 'docs/cmap.pdf',
    displayPath: 'docs/cmap.pdf',
    mediaType: 'application/pdf',
    byteSize: bytes.byteLength,
    bytes,
    contentHash: sha256Hex(bytes),
  };
  const limits = { timeoutMs: 30_000, memoryMb: 2048, residentMemoryMb: 1024 };
  const host = new ParserHost(limits);
  try {
    const result = await host.parse(pdfParser, input);
    expect(result).toMatchObject({ kind: 'excluded', code: 'parse-memory' });
    if (result.kind === 'excluded') {
      expect(result.message).toContain('resident');
      expect(result.message).toContain('1024 MiB');
    }
    const normalBytes = new TextEncoder().encode('# Still usable\n');
    const normal: ParseInput = {
      ...input,
      artifactId: 'memory:docs/ordinary.md',
      relativePath: 'docs/ordinary.md',
      displayPath: 'docs/ordinary.md',
      mediaType: 'text/markdown',
      bytes: normalBytes,
      byteSize: normalBytes.byteLength,
      contentHash: sha256Hex(normalBytes),
    };
    expect(await host.parse(markdownParser, normal)).toEqual({
      kind: 'parsed',
      result: await markdownParser.parse(normal),
    });
  } finally {
    host.close();
  }
}, 45_000);
it('stops its observer without terminating a healthy parser', async () => {
  const { child } = waitingProcess();
  const monitor = monitorResidentMemory(child, 1024);
  monitors.push(monitor);
  await monitor.ready;
  expect(monitor.state.bytes).toBeGreaterThan(0);
  monitor.stop();
  monitor.stop();
  await delay(300);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(monitor.state.error).toBeNull();
}, 15_000);

it.runIf(process.platform === 'darwin')(
  'keeps a completed macOS report queued during a parent stall',
  async () => {
    const { child } = waitingProcess();
    const monitor = monitorResidentMemory(child, 1024);
    monitors.push(monitor);
    const ready = monitor.ready.then(
      () => null,
      (error: unknown) => error,
    );
    const until = performance.now() + 500;
    while (performance.now() < until) {}
    expect(await ready).toBeNull();
    expect(monitor.state.error).toBeNull();
    expect(monitor.state.bytes).toBeGreaterThan(0);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  },
  15_000,
);

// Windows uses a PowerShell observer whose pipe delivery must survive a stalled parent.
it.runIf(process.platform === 'win32')(
  'keeps real PowerShell reports queued during a parent stall',
  async () => {
    const { child } = waitingProcess();
    const original = process.env.LOREPACK_OBSERVER_DIAGNOSTIC;
    let monitor: ResidentMemoryMonitor;
    try {
      process.env.LOREPACK_OBSERVER_DIAGNOSTIC = '1';
      monitor = monitorResidentMemory(child, 1024);
      monitors.push(monitor);
    } finally {
      if (original === undefined) delete process.env.LOREPACK_OBSERVER_DIAGNOSTIC;
      else process.env.LOREPACK_OBSERVER_DIAGNOSTIC = original;
    }
    await monitor.ready;
    await delay(250);
    expect(monitor.state.bytes).toBeGreaterThan(0);
    const until = performance.now() + 800;
    while (performance.now() < until) {}
    await delay(350);
    await nextCheckPhase();
    expect(monitor.state.error).toBeNull();
    expect(monitor.state.bytes).toBeGreaterThan(0);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  },
  15_000,
);

it('does not misreport an exited parser as an observer failure', async () => {
  const { child, closed } = waitingProcess();
  const monitor = monitorResidentMemory(child, 1024);
  monitors.push(monitor);
  await monitor.ready;
  child.kill('SIGKILL');
  await closed;
  await delay(300);
  expect(monitor.state.error).toBeNull();
  expect(monitor.state.exceeded).toBe(false);
}, 15_000);

it.runIf(process.platform === 'win32')(
  'stops parsing when the Windows OS observer cannot start',
  async () => {
    const { child, closed } = waitingProcess();
    const original = process.env.SystemRoot;
    let monitor: ResidentMemoryMonitor;
    try {
      process.env.SystemRoot = join(tmpdir(), `lore-missing-observer-${randomUUID()}`);
      monitor = monitorResidentMemory(child, 1024);
      monitors.push(monitor);
    } finally {
      if (original === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = original;
    }
    await expect(monitor.ready).rejects.toMatchObject({ code: 'LORE_E_PARSE_FAILED' });
    await closed;
    expect(monitor.state.error?.code).toBe('LORE_E_PARSE_FAILED');
    expect(monitor.state.exceeded).toBe(false);
  },
  15_000,
);

for (const residentMemoryMb of [0, 63, 32769, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
  it(`rejects invalid programmatic resident budget ${residentMemoryMb}`, () => {
    expect(() => new ParserHost({ timeoutMs: 30_000, memoryMb: 2048, residentMemoryMb })).toThrow(
      expect.objectContaining({ code: 'LORE_E_INVALID_ARGUMENT' }),
    );
  });
}

function comparisonReader(executable: string, args: string[]) {
  const startedAt = performance.now();
  const samples: Array<{ elapsedMs: number; wallMs: number; bytes: number }> = [];
  let count = 0;
  let pending = '';
  let stderr = '';
  let stopped = false;
  let error: string | null = null;
  let firstSampleMs: number | null = null;
  let lastSampleMs: number | null = null;
  let maxGapMs = 0;
  let failureElapsedMs: number | null = null;
  let resolveSample: () => void = () => {};
  let nextSample = new Promise<void>((resolve) => {
    resolveSample = resolve;
  });
  let resolveFailure: (reason: string) => void = () => {};
  const failure = new Promise<string>((resolve) => {
    resolveFailure = resolve;
  });
  let resolveReady: () => void = () => {};
  const first = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const stop = async () => {
    stopped = true;
    startup.stop();
    reporting.stop();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  };
  const fail = (reason: string) => {
    if (stopped || error !== null) return;
    error = reason;
    failureElapsedMs = performance.now() - startedAt;
    resolveFailure(reason);
    void stop();
  };
  const startup = createStartupWatchdog(() => fail('startup-deadline'));
  const reporting = createReportingWatchdog(() => fail('report-deadline'));
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  processes.push({ child, closed });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-1024);
  });
  child.stdout.on('data', (chunk: string) => {
    if (stopped) return;
    pending += chunk;
    if (pending.length > 4096) {
      fail('stdout-limit');
      return;
    }
    let newline = pending.indexOf('\n');
    while (newline !== -1 && !stopped) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      const bytes = Number(line);
      if (!/^\d+$/.test(line) || !Number.isSafeInteger(bytes) || bytes < 0) {
        fail('invalid-report');
        return;
      }
      const elapsedMs = performance.now() - startedAt;
      firstSampleMs ??= elapsedMs;
      if (lastSampleMs !== null) maxGapMs = Math.max(maxGapMs, elapsedMs - lastSampleMs);
      lastSampleMs = elapsedMs;
      count++;
      if (samples.length === 16) samples.shift();
      samples.push({ elapsedMs, wallMs: Date.now(), bytes });
      startup.stop();
      reporting.report();
      resolveReady();
      const previous = resolveSample;
      nextSample = new Promise<void>((resolve) => {
        resolveSample = resolve;
      });
      previous();
      newline = pending.indexOf('\n');
    }
  });
  child.on('error', () => fail('reader-error'));
  child.once('close', () => fail('reader-exit'));
  const guarded = async (promise: Promise<void>) => {
    const result = await Promise.race([promise.then(() => null), failure]);
    if (result !== null) throw new Error(result);
  };
  const ready = guarded(first);
  void ready.catch(() => undefined);
  return {
    child,
    ready,
    samples,
    failure,
    stop,
    next: () => guarded(nextSample),
    receipt: () => ({
      pid: child.pid ?? null,
      firstSampleMs,
      lastSampleMs,
      maxGapMs,
      failureElapsedMs,
      reports: count,
      samples: samples
        .slice(-8)
        .map(({ elapsedMs, bytes }) => ({ elapsedMs: Math.round(elapsedMs), bytes })),
      failure: error,
      exit: child.exitCode,
      signal: child.signalCode,
      stderr: stderr.slice(-128),
    }),
  };
}

async function independentWindowsSnapshot(pid: number, powershell: string) {
  const command =
    `$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetProcessById(${pid}); ` +
    `[Console]::Out.WriteLine($p.StartTime.ToFileTimeUtc().ToString()); $p.Refresh(); [Console]::Out.WriteLine($p.WorkingSet64)`;
  const child = spawn(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  processes.push({ child, closed });
  let stdout = '';
  let failed = false;
  const guard = createStartupWatchdog(() => {
    failed = true;
    child.kill('SIGKILL');
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.length > 4096) {
      failed = true;
      child.kill('SIGKILL');
    }
  });
  child.stderr.resume();
  child.on('error', () => {
    failed = true;
  });
  try {
    await closed;
    if (failed || child.exitCode !== 0 || child.signalCode !== null)
      throw new Error('Independent Windows snapshot failed.');
    const lines = stdout.trim().split(/\r?\n/);
    if (lines.length !== 2 || !/^\d{1,20}$/.test(lines[0] ?? '') || !/^\d+$/.test(lines[1] ?? ''))
      throw new Error('Invalid independent Windows snapshot.');
    const birth = lines[0];
    const bytes = Number(lines[1]);
    if (birth === undefined || !Number.isSafeInteger(bytes) || bytes <= 0)
      throw new Error('Invalid independent Windows RSS.');
    return { birth, bytes };
  } finally {
    guard.stop();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

it('checks the auxiliary reader controller with actual numeric Node output', async () => {
  const reader = comparisonReader(process.execPath, [
    '-e',
    'console.log(4096); setInterval(() => console.log(8192),100)',
  ]);
  try {
    await reader.ready;
    await reader.next();
    expect(reader.samples.at(-1)?.bytes).toBe(8192);
    expect(reader.receipt().failure).toBeNull();
  } finally {
    await reader.stop();
  }
  expect(reader.child.signalCode).toBe('SIGKILL');
});

it('fails and joins an actual silent auxiliary reader at the original startup guard', async () => {
  const reader = comparisonReader(process.execPath, ['-e', 'setInterval(() => {},1000)']);
  try {
    await expect(reader.ready).rejects.toThrow('startup-deadline');
    expect(reader.receipt().reports).toBe(0);
  } finally {
    await reader.stop();
  }
  expect(reader.child.signalCode).toBe('SIGKILL');
}, 10000);

it('fails and joins an actual auxiliary reader that stops reporting', async () => {
  const reader = comparisonReader(process.execPath, [
    '-e',
    'console.log(4096); setInterval(() => {},1000)',
  ]);
  try {
    await reader.ready;
    expect(await reader.failure).toBe('report-deadline');
  } finally {
    await reader.stop();
  }
  expect(reader.child.signalCode).toBe('SIGKILL');
});

it.runIf(process.platform === 'win32')(
  'compares auxiliary cscript WMI RSS with independent Windows snapshots on native blocked growth',
  async () => {
    const systemRoot = Object.entries(process.env).find(
      ([key]) => key.toLowerCase() === 'systemroot',
    )?.[1];
    if (systemRoot === undefined || !win32.isAbsolute(systemRoot))
      throw new Error('Missing absolute SystemRoot.');
    const powershell = win32.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const cscript = win32.join(systemRoot, 'System32', 'cscript.exe');
    const fixture = fileURLToPath(new URL('./fixtures/windows_wmi_reader.cjs', import.meta.url));
    const target = spawn(
      process.execPath,
      [
        '--permission',
        '--allow-fs-read=*',
        '--max-old-space-size=2048',
        fileURLToPath(new URL('./fixtures/resident_growth.mjs', import.meta.url)),
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    const targetClosed = new Promise<void>((resolve) => target.once('close', () => resolve()));
    processes.push({ child: target, closed: targetClosed });
    const readers: ReturnType<typeof comparisonReader>[] = [];
    let candidate: ReturnType<typeof comparisonReader> | undefined;
    let invalid: ReturnType<typeof comparisonReader> | undefined;
    let error: unknown;
    let finalReceipt = '';
    let growthSamples: Array<{ elapsedMs: number; wallMs: number; bytes: number }> = [];
    let initialReference: { birth: string; bytes: number } | undefined;
    let initialCandidate: number | undefined;
    let reference: { birth: string; bytes: number } | undefined;
    let growth: { startedAt: number; finishedAt: number; blockedMs: number } | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        const guard = createStartupWatchdog(() => {
          target.kill('SIGKILL');
          reject(new Error('Auxiliary target startup failed.'));
        });
        void once(target, 'message').then(
          () => guard.stop(),
          () => guard.stop(),
        );
      });
      const [readyMessage] = await Promise.race([once(target, 'message'), timeout]);
      expect(readyMessage).toEqual({ kind: 'ready' });
      const pid = target.pid;
      if (pid === undefined) throw new Error('Target has no PID.');
      const before = await independentWindowsSnapshot(pid, powershell);
      initialReference = before;
      candidate = comparisonReader(cscript, [
        '//B',
        '//Nologo',
        '//E:JScript',
        fixture,
        String(pid),
        before.birth,
      ]);
      readers.push(candidate);
      const ownedStart = processes.findIndex(({ child }) => child === target);
      void candidate.failure.then(() => {
        for (const { child } of processes.slice(ownedStart))
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      });
      await candidate.ready;
      const initial = candidate.samples.at(-1)?.bytes;
      initialCandidate = initial;
      if (initial === undefined) throw new Error('Missing candidate baseline.');
      const grown = once(target, 'message');
      target.send('grow');
      const [message] = await Promise.race([
        grown,
        candidate.failure.then((reason) => {
          throw new Error(reason);
        }),
      ]);
      growth = message as typeof growth;
      expect(message).toMatchObject({ kind: 'grown' });
      expect(growth?.blockedMs).toBeGreaterThanOrEqual(800);
      if (growth === undefined) throw new Error('Missing native growth interval.');
      const interval = growth;
      growthSamples = candidate.samples.filter(
        ({ wallMs }) => wallMs >= interval.startedAt && wallMs <= interval.finishedAt,
      );
      await candidate.next();
      await candidate.next();
      reference = await independentWindowsSnapshot(pid, powershell);
      expect(reference.birth).toBe(before.birth);
      expect(reference.bytes - before.bytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
      const after = candidate.samples.at(-1)?.bytes;
      if (after === undefined || growth === undefined)
        throw new Error('Missing native growth reports.');
      expect(after - initial).toBeGreaterThanOrEqual(64 * 1024 * 1024);
      expect(Math.abs(after - reference.bytes)).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(new Set(growthSamples.map(({ bytes }) => bytes)).size).toBeGreaterThanOrEqual(3);
      expect(candidate.receipt().failure).toBeNull();
      invalid = comparisonReader(cscript, [
        '//B',
        '//Nologo',
        '//E:JScript',
        fixture,
        String(pid),
        (BigInt(before.birth) + 10n).toString(),
      ]);
      readers.push(invalid);
      expect(await invalid.failure).toBe('reader-exit');
      await invalid.stop();
      expect(invalid.receipt()).toMatchObject({ reports: 0, exit: 1, signal: null });
      expect(invalid.receipt().stderr).toContain('LPF:identity:');
      target.kill('SIGKILL');
      await targetClosed;
      const targetExitFailure = await candidate.failure;
      expect(['reader-exit', 'report-deadline']).toContain(targetExitFailure);
      await candidate.stop();
      const targetExitReceipt = candidate.receipt();
      expect(targetExitReceipt).toMatchObject({ exit: 1, signal: null });
      expect(targetExitReceipt.stderr).toContain('LPF:get:');
      if (targetExitFailure === 'report-deadline') {
        const { lastSampleMs, failureElapsedMs } = targetExitReceipt;
        expect(lastSampleMs).not.toBeNull();
        expect(failureElapsedMs).not.toBeNull();
        if (lastSampleMs === null || failureElapsedMs === null)
          throw new Error('Missing report deadline timing.');
        expect(failureElapsedMs - lastSampleMs).toBeGreaterThanOrEqual(250);
      }
    } catch (failure) {
      error = failure;
    } finally {
      await Promise.all(readers.map((reader) => reader.stop()));
      if (target.exitCode === null && target.signalCode === null) target.kill('SIGKILL');
      await targetClosed;
      finalReceipt = JSON.stringify({
        auxiliaryOnly: true,
        warmup: 'independent Framework snapshot precedes fresh WMI reader',
        candidate: candidate?.receipt() ?? null,
        invalidIdentity: invalid?.receipt() ?? null,
        initialReference,
        initialCandidate,
        reference,
        growth,
        growthSamples,
        fixtureSha256: sha256Hex(readFileSync(fixture)),
        target: { pid: target.pid, exit: target.exitCode, signal: target.signalCode },
      });
      process.stderr.write(`LOREPACK_WMI_CONTROL ${finalReceipt}\n`);
    }
    if (error !== undefined) throw error;
    expect(Buffer.byteLength(finalReceipt)).toBeLessThanOrEqual(4096);
  },
  45000,
);
