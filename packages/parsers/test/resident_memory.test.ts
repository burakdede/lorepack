import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay, setImmediate as nextCheckPhase } from 'node:timers/promises';

import type { ParseInput } from '@lorepack/core';
import { sha256Hex } from '@lorepack/core';
import { markdownParser, ParserHost, pdfParser } from '@lorepack/parsers';
import { cmapBombPdf } from '@lorepack/test-support';
import { afterEach, expect, it } from 'vitest';
import {
  createReportingWatchdog,
  createStartupWatchdog,
  monitorResidentMemory,
  type ResidentMemoryMonitor,
} from '../src/resident_memory.js';

const processes: { child: ChildProcess; closed: Promise<unknown> }[] = [];
const monitors: ResidentMemoryMonitor[] = [];

it('services a pending first observer report at the original startup deadline', async () => {
  const startedAt = Date.now();
  let expired = false;
  const startup = createStartupWatchdog(() => {
    expired = true;
  });
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

it('rejects an observer with no first report at the original startup deadline', async () => {
  let expired = false;
  const startup = createStartupWatchdog(() => {
    expired = true;
  });
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
