import { ChildProcess, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { monitorResidentMemory, type ResidentMemoryMonitor } from '../src/resident_memory.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readFile: vi.fn(),
}));

const monitors: ResidentMemoryMonitor[] = [];
let nowMs = 100;

afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
  vi.mocked(readFile).mockReset();
});

function parserOn(platform: 'linux' | 'darwin') {
  nowMs = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  const parser = new ChildProcess();
  Object.defineProperty(parser, 'pid', { value: process.pid });
  vi.spyOn(parser, 'kill').mockReturnValue(true);
  vi.stubGlobal('process', { ...process, platform });
  return parser;
}

function macReader() {
  const reader = new ChildProcess();
  Object.defineProperties(reader, {
    pid: { value: 12961 },
    stdout: { value: new PassThrough() },
    stderr: { value: new PassThrough() },
  });
  vi.spyOn(reader, 'kill').mockReturnValue(true);
  vi.mocked(spawn).mockReturnValue(reader);
  return reader;
}

function context(monitor: ResidentMemoryMonitor) {
  const error = monitor.state.error?.cause as Error;
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(/^POSIX resident-memory read context: /);
  return {
    error,
    value: JSON.parse(error.message.slice('POSIX resident-memory read context: '.length)),
  };
}

it('retains Linux timeout timing and the original abort chain without sensitive trace fields', async () => {
  const parser = parserOn('linux');
  const reason = new DOMException('sensitive-timeout-detail', 'TimeoutError');
  const original = Object.assign(new Error('sensitive-report-path', { cause: reason }), {
    name: 'AbortError',
  });
  vi.mocked(readFile).mockImplementation(async () => {
    nowMs = 349.95;
    throw original;
  });
  const monitor = monitorResidentMemory(parser, 1024);
  monitors.push(monitor);
  await expect(monitor.ready).rejects.toMatchObject({ code: 'LORE_E_PARSE_FAILED' });
  const { error, value } = context(monitor);
  expect(error.cause).toBe(original);
  expect(value).toEqual({
    platform: 'linux',
    samplePhase: 'initial',
    elapsedMs: 249.95,
    readerPid: null,
    exitCode: null,
    signalCode: null,
    localKillRequested: null,
    abortReason: 'TimeoutError',
  });
  expect(error.message).not.toContain('sensitive');
  expect(parser.kill).toHaveBeenCalledWith('SIGKILL');
  expect(readFile).toHaveBeenCalledTimes(1);
});

it('distinguishes a later Linux read failure while preserving the 100 ms sample interval', async () => {
  vi.useFakeTimers();
  const parser = parserOn('linux');
  const original = Object.assign(new Error('OS report failed'), { code: 'EIO' });
  vi.mocked(readFile)
    .mockResolvedValueOnce('Rss: 312 kB\n')
    .mockImplementationOnce(async () => {
      nowMs = 480;
      throw original;
    });
  const monitor = monitorResidentMemory(parser, 1024);
  monitors.push(monitor);
  await monitor.ready;
  nowMs = 200;
  await vi.advanceTimersByTimeAsync(99);
  expect(readFile).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(readFile).toHaveBeenCalledTimes(2);
  const { error, value } = context(monitor);
  expect(error.cause).toBe(original);
  expect(value).toMatchObject({ samplePhase: 'subsequent', elapsedMs: 280, abortReason: null });
  expect(monitor.state.bytes).toBe(312 * 1024);
  expect(parser.kill).toHaveBeenCalledWith('SIGKILL');
});

it('excludes arbitrary native error names and messages from structured reader context', async () => {
  const parser = parserOn('linux');
  const original = Object.assign(new Error('credential-secret'.repeat(1000)), {
    name: 'private-reader-path',
  });
  vi.mocked(readFile).mockRejectedValue(original);
  const monitor = monitorResidentMemory(parser, 1024);
  monitors.push(monitor);
  await expect(monitor.ready).rejects.toMatchObject({ code: 'LORE_E_PARSE_FAILED' });
  const { error, value } = context(monitor);
  expect(error.cause).toBe(original);
  expect(value.abortReason).toBeNull();
  expect(Buffer.byteLength(error.message)).toBeLessThan(1024);
  expect(error.message).not.toContain('credential-secret');
  expect(error.message).not.toContain('private-reader-path');
});

it.each([false, true])(
  'records macOS reader exit state without interpreting local kill requested=%s as a cause',
  async (localKillRequested) => {
    const parser = parserOn('darwin');
    const reader = macReader();
    const monitor = monitorResidentMemory(parser, 1024);
    monitors.push(monitor);
    const ready = monitor.ready.catch((error: unknown) => error);
    nowMs = 370;
    Object.defineProperties(reader, {
      signalCode: { value: 'SIGKILL' },
      killed: { value: localKillRequested },
    });
    reader.emit('close', null, 'SIGKILL');
    expect(await ready).toMatchObject({ code: 'LORE_E_PARSE_FAILED' });
    const { error, value } = context(monitor);
    expect((error.cause as Error).message).toBe(
      'macOS resident-memory reader exited (SIGKILL). ""',
    );
    expect(value).toEqual({
      platform: 'darwin',
      samplePhase: 'initial',
      elapsedMs: 270,
      readerPid: 12961,
      exitCode: null,
      signalCode: 'SIGKILL',
      localKillRequested,
      abortReason: null,
    });
    expect(spawn).toHaveBeenCalledWith('/bin/ps', ['-o', 'rss=', '-p', String(process.pid)], {
      timeout: 250,
      killSignal: 'SIGKILL',
    });
    expect(parser.kill).toHaveBeenCalledWith('SIGKILL');
  },
);

it('suppresses a late macOS reader rejection after intentional monitor stop', async () => {
  const parser = parserOn('darwin');
  const reader = macReader();
  const monitor = monitorResidentMemory(parser, 1024);
  monitors.push(monitor);
  void monitor.ready.catch(() => undefined);
  monitor.stop();
  Object.defineProperty(reader, 'signalCode', { value: 'SIGKILL' });
  reader.emit('close', null, 'SIGKILL');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(monitor.state.error).toBeNull();
  expect(parser.kill).not.toHaveBeenCalled();
  expect(reader.kill).toHaveBeenCalledWith('SIGKILL');
});
