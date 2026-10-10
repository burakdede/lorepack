import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ownProcessStart, processStart, sameProcessStart } from '../src/process-start.js';

/**
 * The probe the project lock uses to tell a lock's owner from a process that inherited its
 * pid (#565). It shells out to `ps` on macOS and PowerShell on Windows and reads `/proc` on
 * Linux, so these run against the real operating system on every CI platform.
 */

const COMPILED = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'process-start.js')).href;

describe('process start identity', () => {
  it('agrees with itself: the probe of this process matches what it records', () => {
    const observed = processStart(process.pid);
    expect(observed).not.toBeNull();
    expect(sameProcessStart(ownProcessStart(), observed ?? '')).toBe(true);
  });

  it('agrees for another live process', async () => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(COMPILED)}); console.log(m.ownProcessStart()); setTimeout(() => {}, 60000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      const recorded = await new Promise<string>((resolve) => {
        child.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8').trim()));
      });
      const observed = processStart(child.pid ?? -1);
      expect(observed).not.toBeNull();
      expect(sameProcessStart(recorded, observed ?? '')).toBe(true);
    } finally {
      child.kill();
    }
  });

  it('cannot describe a process that has exited', () => {
    const exited = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    expect(processStart(exited.pid ?? -1)).toBeNull();
  });

  it('rejects pids that are not positive integers without probing', () => {
    expect(processStart(0)).toBeNull();
    expect(processStart(-1)).toBeNull();
    expect(processStart(1.5)).toBeNull();
  });

  it('compares Linux ticks exactly and wall-clock starts within a tolerance', () => {
    expect(sameProcessStart('linux:100', 'linux:100')).toBe(true);
    expect(sameProcessStart('linux:100', 'linux:101')).toBe(false);
    expect(sameProcessStart('epoch:1000000', 'epoch:1001000')).toBe(true);
    expect(sameProcessStart('epoch:1000000', 'epoch:1600000')).toBe(false);
  });

  it('cannot tell when the identities are of different kinds or missing', () => {
    expect(sameProcessStart('linux:100', 'epoch:100')).toBe(true);
    expect(sameProcessStart('', 'epoch:100')).toBe(true);
  });
});
