import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
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
  Object.defineProperties(reader, {
    stdout: { value: stdout },
    stderr: { value: new PassThrough() },
  });
  vi.spyOn(reader, 'kill').mockReturnValue(true);
  vi.mocked(spawn).mockReturnValue(reader);
  vi.stubGlobal('process', { ...process, platform: 'win32', env: environment });
  return { parser, reader, stdout };
}

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
