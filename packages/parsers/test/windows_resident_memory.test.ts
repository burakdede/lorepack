import { ChildProcess, spawn } from 'node:child_process';
import { performance as nodePerformance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { setTimeout as delay, setImmediate as nextCheckPhase } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { monitorResidentMemory } from '../src/resident_memory.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

function windowsObserver(environment: NodeJS.ProcessEnv) {
  const parser = new ChildProcess();
  Object.defineProperty(parser, 'pid', { value: process.pid });
  vi.spyOn(parser, 'kill').mockReturnValue(true);
  const reader = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperties(reader, {
    stdout: { value: stdout },
    stderr: { value: stderr },
  });
  vi.spyOn(reader, 'kill').mockReturnValue(true);
  vi.mocked(spawn).mockReturnValue(reader);
  vi.stubGlobal('process', { ...process, platform: 'win32', env: environment });
  return { parser, reader, stdout, stderr };
}

it('retains a bounded diagnostic when an alive Windows reader stops reporting', async () => {
  const { parser, reader, stdout, stderr } = windowsObserver({
    SystemRoot: 'C:\\Windows',
    LOREPACK_OBSERVER_DIAGNOSTIC: '1',
    LOREPACK_FAKE_SECRET: 'credential-secret',
  });
  const diagnosticLines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    diagnosticLines.push(String(chunk));
    return true;
  });
  const monitor = monitorResidentMemory(parser, 1024);
  try {
    const command = vi.mocked(spawn).mock.calls[0]?.[1]?.[4];
    expect(command).toContain('[Console]::Out.WriteLine($rss)');
    expect(command).toContain('[Threading.Thread]::Sleep(100)');
    for (let report = 1; report <= 5; report++) {
      stdout.write('81219584\n');
      stderr.write(`LPR:${report}:${String(report * 100)}\n`);
    }
    stderr.write('sensitive-path:docs/runbook.md\n');
    await monitor.ready;
    await delay(350);
    await nextCheckPhase();
    expect(monitor.state.error?.code).toBe('LORE_E_PARSE_FAILED');
    expect(parser.kill).toHaveBeenCalledWith('SIGKILL');
    expect(reader.kill).toHaveBeenCalledWith('SIGKILL');
    const cause = monitor.state.error?.cause;
    expect(cause).toBeInstanceOf(Error);
    const message = (cause as Error).message;
    const prefix = 'Observer trace: ';
    expect(message).toContain(prefix);
    const early = JSON.parse(message.slice(message.indexOf(prefix) + prefix.length)) as {
      readerCloseObserved: boolean;
      events: Array<Record<string, unknown>>;
    };
    expect(early.readerCloseObserved).toBe(false);
    expect(diagnosticLines).toEqual([]);
    stderr.write('LPR:6:600\n');
    reader.emit('close', 0, null);
    expect(monitor.state.error?.cause).toBe(cause);
    const final = JSON.parse((cause as Error).message.split(prefix)[1] ?? '') as typeof early;
    expect(final.readerCloseObserved).toBe(true);
    expect(final.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'emission', reports: 6, readerMs: 600 }),
        expect.objectContaining({ kind: 'close', exitCode: 0, signal: 'none' }),
      ]),
    );
    expect(diagnosticLines).toHaveLength(1);
    expect(Buffer.byteLength(diagnosticLines[0] ?? '')).toBeLessThanOrEqual(4097);
    expect(diagnosticLines[0]).toContain('LOREPACK_OBSERVER_DIAGNOSTIC_FINAL ');
    expect(diagnosticLines[0]).toContain('"readerCloseObserved":true');
    const events = final.events;
    expect(events.length).toBeLessThanOrEqual(16);
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['emission', 'receipt', 'arm', 'fire', 'check']),
    );
    for (const event of events) {
      expect(
        Object.keys(event).every((key) =>
          [
            'kind',
            'reports',
            'bytes',
            'readerMs',
            'parentMs',
            'exitCode',
            'signal',
            'ownerElapsedMs',
            'deadlineDeltaMs',
            'ownerActiveMs',
            'ownerIdleMs',
            'ownerUtilization',
          ].includes(key),
        ),
      ).toBe(true);
    }
    expect(message).not.toContain('credential-secret');
    expect(message).not.toContain('docs/runbook.md');
    expect(diagnosticLines[0]).not.toContain('credential-secret');
    expect(diagnosticLines[0]).not.toContain('docs/runbook.md');
  } finally {
    monitor.stop();
  }
}, 10000);

it('accepts the first RSS sample after delayed PowerShell startup', async () => {
  vi.useFakeTimers();
  const { parser, reader, stdout } = windowsObserver({ SystemRoot: 'C:\\Windows' });
  const monitor = monitorResidentMemory(parser, 1024);
  const ready = monitor.ready;
  try {
    reader.emit('spawn');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(monitor.state.error).toBeNull();
    expect(parser.kill).not.toHaveBeenCalled();

    stdout.write('4096\n');
    await expect(ready).resolves.toBeUndefined();
    expect(monitor.state.bytes).toBe(4096);
  } finally {
    monitor.stop();
    reader.emit('close', 0, null);
  }
});

it('records a fail-closed startup trace at the Windows startup deadline', async () => {
  vi.useFakeTimers();
  const { parser, reader, stderr } = windowsObserver({
    SystemRoot: 'C:\\Windows',
    LOREPACK_OBSERVER_DIAGNOSTIC: '1',
  });
  const diagnosticLines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    diagnosticLines.push(String(chunk));
    return true;
  });
  const monitor = monitorResidentMemory(parser, 1024);
  const ready = monitor.ready.catch((error: unknown) => error);
  try {
    const command = vi.mocked(spawn).mock.calls[0]?.[1]?.[4] ?? '';
    expect(command).toContain("[Threading.Thread]::Sleep(100); [Console]::Error.WriteLine('LPP:'");
    const milestones = [
      'LPS:entry:',
      'LPI:ps:',
      'LPI:clr:',
      'LPI:process:',
      '::GetProcessById(',
      ':before-refresh:',
      '$p.Refresh()',
      ':after-refresh:',
      ':before-rss:',
      '$rss=$p.WorkingSet64',
      ':after-rss:',
      ':before-write:',
      '[Console]::Out.WriteLine($rss)',
      ':after-write:',
      ':before-sleep:',
      '[Threading.Thread]::Sleep(100)',
      ':after-sleep:',
    ];
    let previous = -1;
    for (const milestone of milestones) {
      const position = command.indexOf(milestone);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    reader.emit('spawn');
    stderr.write('LPS:entry:0\nLPS:refresh:1\n');
    vi.advanceTimersByTime(14_999);
    expect(monitor.state.error).toBeNull();
    expect(parser.kill).not.toHaveBeenCalled();
    expect(reader.kill).not.toHaveBeenCalled();
    expect(diagnosticLines).toEqual([]);
    vi.advanceTimersByTime(1);
    vi.runOnlyPendingTimers();
    expect(await ready).toMatchObject({ code: 'LORE_E_PARSE_FAILED' });
    expect(monitor.state.bytes).toBeNull();
    expect(monitor.state.exceeded).toBe(false);
    expect(parser.kill).toHaveBeenCalledWith('SIGKILL');
    expect(reader.kill).toHaveBeenCalledWith('SIGKILL');
    const cause = monitor.state.error?.cause as Error;
    const snapshot = () =>
      JSON.parse(cause.message.split('Observer trace: ')[1] ?? '') as {
        readerCloseObserved: boolean;
        events: Array<Record<string, unknown>>;
      };
    expect(snapshot().events.map((event) => event.kind)).toEqual([
      'startup-arm',
      'spawn',
      'script',
      'script',
      'startup-fire',
      'startup-check',
    ]);
    expect(snapshot().readerCloseObserved).toBe(false);
    expect(diagnosticLines).toEqual([]);
    for (let index = 0; index < 24; index++) stderr.write(`LPS:rss:${String(index)}\n`);
    stderr.write('LPS:arbitrary-secret:1\nLPS:entry:credential-secret\n');
    stderr.write('sensitive-path:docs/runbook.md\n');
    reader.emit('close', 1, null);
    const final = snapshot();
    expect(final.readerCloseObserved).toBe(true);
    expect(final.events).toHaveLength(16);
    expect(final.events).toContainEqual(
      expect.objectContaining({ kind: 'script', phase: 'rss', readerMs: 23 }),
    );
    expect(final.events.at(-1)).toMatchObject({ kind: 'close', exitCode: 1, signal: 'none' });
    expect(diagnosticLines).toHaveLength(1);
    expect(Buffer.byteLength(diagnosticLines[0] ?? '')).toBeLessThanOrEqual(4097);
    for (const secret of ['arbitrary-secret', 'credential-secret', 'docs/runbook.md']) {
      expect(JSON.stringify(final)).not.toContain(secret);
      expect(diagnosticLines[0]).not.toContain(secret);
    }
  } finally {
    monitor.stop();
  }
});

it('keeps startup instrumentation out of an observer without the opt-in', async () => {
  const { parser, reader, stdout } = windowsObserver({ SystemRoot: 'C:\\Windows' });
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const utilization = vi.spyOn(nodePerformance, 'eventLoopUtilization');
  const monitor = monitorResidentMemory(parser, 1024);
  try {
    const command = vi.mocked(spawn).mock.calls[0]?.[1]?.[4];
    expect(command).not.toContain('LPS:');
    expect(command).not.toContain('LPR:');
    expect(command).not.toContain('LPP:');
    expect(command).not.toContain('LPI:');
    expect(command).toContain('[Console]::Out.WriteLine($p.WorkingSet64)');
    stdout.write('4096\n');
    await monitor.ready;
    monitor.stop();
    reader.emit('close', 0, null);
    expect(monitor.state.error).toBeNull();
    expect(output).not.toHaveBeenCalled();
    expect(utilization).not.toHaveBeenCalled();
  } finally {
    monitor.stop();
  }
});

it('retains bounded per-sample phases and one runtime identity across the event ring', async () => {
  vi.useFakeTimers();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const utilization = vi.spyOn(nodePerformance, 'eventLoopUtilization');
  utilization.mockReturnValue({ idle: 0.05, active: 249.95, utilization: 0.9998 });
  const { parser, reader, stdout, stderr } = windowsObserver({
    SystemRoot: 'C:\\Windows',
    LOREPACK_OBSERVER_DIAGNOSTIC: '1',
  });
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const monitor = monitorResidentMemory(parser, 1024);
  try {
    stderr.write('LPI:ps:5.1.26100.1\nLPI:clr:4.0.30319.42000\n');
    stderr.write(
      'LPI:process:System, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089\n',
    );
    stderr.write('LPI:ps:9.9\nLPI:process:credential/secret\n');
    stdout.write('4096\n');
    await monitor.ready;
    for (let sample = 1; sample <= 3; sample++) {
      for (const phase of [
        'before-refresh',
        'after-refresh',
        'before-rss',
        'after-rss',
        'before-write',
        'after-write',
        'before-sleep',
        'after-sleep',
      ])
        stderr.write(`LPP:${String(sample)}:${phase}:${String(sample * 100)}\n`);
    }
    stderr.write('LPP:3:arbitrary-secret:1\nLPP:3:before-rss:credential-secret\n');
    now = 249.95;
    vi.advanceTimersByTime(250);
    vi.runOnlyPendingTimers();
    now = 250;
    vi.advanceTimersByTime(1);
    vi.runOnlyPendingTimers();
    reader.emit('close', null, 'SIGKILL');
    const cause = monitor.state.error?.cause as Error;
    const trace = JSON.parse(cause.message.split('Observer trace: ')[1] ?? '');
    expect(trace.identity).toEqual({
      ps: '5.1.26100.1',
      clr: '4.0.30319.42000',
      process: 'System, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089',
    });
    expect(trace.events).toHaveLength(16);
    expect(trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'sample', reports: 3, phase: 'before-rss', readerMs: 300 }),
        expect.objectContaining({
          kind: 'sample',
          reports: 3,
          phase: 'after-sleep',
          readerMs: 300,
        }),
        expect.objectContaining({
          kind: 'fire',
          ownerElapsedMs: 249.95,
          deadlineDeltaMs: -0.05,
          ownerActiveMs: 249.95,
          ownerIdleMs: 0.05,
          ownerUtilization: 1,
        }),
        expect.objectContaining({ kind: 'check', ownerElapsedMs: 250, deadlineDeltaMs: 0 }),
      ]),
    );
    expect(JSON.stringify(trace)).not.toContain('secret');
    expect(Buffer.byteLength(String(output.mock.calls[0]?.[0]))).toBeLessThanOrEqual(4097);
    expect(utilization).toHaveBeenCalled();
  } finally {
    monitor.stop();
  }
});

it('does not emit a diagnostic after a successful Windows observer stop', async () => {
  const { parser, reader, stdout, stderr } = windowsObserver({
    SystemRoot: 'C:\\Windows',
    LOREPACK_OBSERVER_DIAGNOSTIC: '1',
  });
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const monitor = monitorResidentMemory(parser, 1024);
  reader.emit('spawn');
  stderr.write('LPS:entry:0\nLPS:refresh:1\nLPS:rss:2\nLPS:before-write:3\n');
  stdout.write('4096\n');
  await monitor.ready;
  monitor.stop();
  reader.emit('close', 0, null);
  await delay(300);
  expect(monitor.state.error).toBeNull();
  expect(parser.kill).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
});

it.each(['SystemRoot', 'SYSTEMROOT', 'systemroot', 'sYsTeMrOoT'])(
  'observes parser RSS with the worker environment key %s',
  async (key) => {
    const { parser, reader, stdout } = windowsObserver({ [key]: 'C:\\Windows' });
    const monitor = monitorResidentMemory(parser, 1024);
    try {
      stdout.write('4096\n');
      await expect(monitor.ready).resolves.toBeUndefined();
      expect(spawn).toHaveBeenCalledWith(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        expect.any(Array),
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(monitor.state).toEqual({ bytes: 4096, exceeded: false, error: null });
      expect(parser.kill).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
    }
    expect(reader.kill).toHaveBeenCalledWith('SIGKILL');
  },
);

it.each([{}, { SYSTEMROOT: 'relative' }, { systemroot: '' }])(
  'still rejects a missing or relative Windows root %j',
  async (environment) => {
    const { parser } = windowsObserver(environment);
    const monitor = monitorResidentMemory(parser, 1024);
    await expect(monitor.ready).rejects.toMatchObject({
      code: 'LORE_E_PARSE_FAILED',
      cause: { message: 'Windows did not provide an absolute SystemRoot.' },
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(parser.kill).toHaveBeenCalledWith('SIGKILL');
  },
);
