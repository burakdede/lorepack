import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { setTimeout as delay, setImmediate as nextCheckPhase } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { monitorResidentMemory } from '../src/resident_memory.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

afterEach(() => {
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
    expect(command).toContain('[Console]::Out.WriteLine($p.WorkingSet64)');
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
          ['kind', 'reports', 'bytes', 'readerMs', 'parentMs', 'exitCode', 'signal'].includes(key),
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

it('does not emit a diagnostic after a successful Windows observer stop', async () => {
  const { parser, reader, stdout } = windowsObserver({
    SystemRoot: 'C:\\Windows',
    LOREPACK_OBSERVER_DIAGNOSTIC: '1',
  });
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const monitor = monitorResidentMemory(parser, 1024);
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
