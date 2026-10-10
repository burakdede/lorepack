import { mkdirSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { withTempProject } from '@lorepack/test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectLock } from '../src/lock.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: vi.fn(actual.platform) };
});

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(platform).mockReturnValue('win32');
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(platform).mockReturnValue(process.platform);
  vi.mocked(mkdirSync).mockImplementation(realFs.mkdirSync);
  vi.mocked(writeFileSync).mockImplementation(realFs.writeFileSync);
});

function denyCreates(path: string, cause: Error, failures = Number.POSITIVE_INFINITY) {
  let attempts = 0;
  vi.mocked(mkdirSync).mockImplementation((target, options) => {
    if (target === path && ++attempts <= failures) throw cause;
    return realFs.mkdirSync(target, options);
  });
  return () => attempts;
}

function denied(code = 'EPERM') {
  return Object.assign(new Error('directory creation denied'), { code });
}

describe('lock directory creation errors', () => {
  it('retries a transient Windows EPERM and acquires the lock', async () => {
    await withTempProject({}, async (project) => {
      const path = project.path('.lore/lock');
      const attempts = denyCreates(path, denied(), 2);
      const lock = new ProjectLock(path, { waitMs: 20, pollIntervalMs: 5 });
      const outcome = lock.acquire().catch((cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(10);
      expect(await outcome).toBeUndefined();
      expect(attempts()).toBe(3);
      expect(lock.held).toBe(true);
      lock.release();
    });
  });

  it('returns persistent Windows EPERM at the original wait deadline', async () => {
    await withTempProject({}, async (project) => {
      const path = project.path('.lore/lock');
      const cause = denied();
      const attempts = denyCreates(path, cause);
      const lock = new ProjectLock(path, { waitMs: 20, pollIntervalMs: 5 });
      const started = Date.now();
      const outcome = lock.acquire().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      expect(await outcome).toBe(cause);
      expect(attempts()).toBe(5);
      expect(Date.now() - started).toBe(20);
      expect(lock.held).toBe(false);
    });
  });

  for (const operatingSystem of ['darwin', 'linux'] as const) {
    it(`returns ${operatingSystem} EPERM immediately`, async () => {
      await withTempProject({}, async (project) => {
        vi.mocked(platform).mockReturnValue(operatingSystem);
        const path = project.path('.lore/lock');
        const cause = denied();
        const attempts = denyCreates(path, cause);
        const lock = new ProjectLock(path);
        await expect(lock.acquire()).rejects.toBe(cause);
        expect(attempts()).toBe(1);
      });
    });
  }

  it('returns other Windows creation errors immediately', async () => {
    await withTempProject({}, async (project) => {
      const path = project.path('.lore/lock');
      const cause = denied('EACCES');
      const attempts = denyCreates(path, cause);
      await expect(new ProjectLock(path).acquire()).rejects.toBe(cause);
      expect(attempts()).toBe(1);
    });
  });

  it('returns parent-directory EPERM immediately', async () => {
    await withTempProject({}, async (project) => {
      const path = project.path('.lore/lock');
      const cause = denied();
      const attempts = denyCreates(dirname(path), cause);
      await expect(new ProjectLock(path).acquire()).rejects.toBe(cause);
      expect(attempts()).toBe(1);
    });
  });

  it('returns owner-record EPERM immediately', async () => {
    await withTempProject({}, async (project) => {
      const path = project.path('.lore/lock');
      const cause = denied();
      vi.mocked(writeFileSync).mockImplementation((target, data, options) => {
        if (target === join(path, 'owner.json')) throw cause;
        return realFs.writeFileSync(target, data, options);
      });
      await expect(new ProjectLock(path).acquire()).rejects.toBe(cause);
    });
  });
});
