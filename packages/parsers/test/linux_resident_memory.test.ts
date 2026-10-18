import { beforeEach, expect, it, vi } from 'vitest';
import { readLinuxResidentMemory } from '../src/resident_memory.js';

const { report } = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readFile: report,
}));

beforeEach(() => {
  report.mockReset();
});

it('reads resident bytes from the exact owned Linux process report', async () => {
  report.mockResolvedValue(
    '00400000-00500000 ---p 00000000 00:00 0 [rollup]\nRss:    312 kB\nPss:    100 kB\n',
  );
  expect(await readLinuxResidentMemory(12961)).toBe(312 * 1024);
  expect(report).toHaveBeenCalledExactlyOnceWith('/proc/12961/smaps_rollup', {
    encoding: 'utf8',
    signal: expect.any(AbortSignal),
  });
});

it('keeps zero resident memory as a valid measurement', async () => {
  report.mockResolvedValue('Rss: 0 kB\n');
  expect(await readLinuxResidentMemory(12961)).toBe(0);
});

it('recognizes Linux ESRCH before the child exit event without retrying', async () => {
  report.mockRejectedValue(
    Object.assign(new Error('no such process'), {
      code: 'ESRCH',
      errno: -3,
      syscall: 'open',
      path: '/proc/12961/smaps_rollup',
    }),
  );
  expect(await readLinuxResidentMemory(12961)).toBeNull();
  expect(report).toHaveBeenCalledTimes(1);
});

it.each(['ENOENT', 'EACCES', 'EIO'])('preserves genuine Linux report failure %s', async (code) => {
  const error = Object.assign(new Error('OS report failed'), { code });
  report.mockRejectedValue(error);
  await expect(readLinuxResidentMemory(12961)).rejects.toBe(error);
  expect(report).toHaveBeenCalledTimes(1);
});

it.each([
  ['empty', ''],
  ['nonnumeric', 'Rss: unknown kB\n'],
  ['negative', 'Rss: -1 kB\n'],
])('rejects %s Linux rollup', async (_name, value) => {
  report.mockResolvedValue(value);
  await expect(readLinuxResidentMemory(12961)).rejects.toThrow(
    'Linux did not report parser resident memory.',
  );
});
