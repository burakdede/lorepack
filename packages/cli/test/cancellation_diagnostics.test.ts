import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { observeChild, scheduleDeadlineDiagnostics } from './support/child_diagnostics.js';

it('captures a long-running test before its deadline and clears the timer on completion', () => {
  vi.useFakeTimers();
  try {
    const capture = vi.fn();
    const clear = scheduleDeadlineDiagnostics(capture, 180_000);

    vi.advanceTimersByTime(174_999);
    expect(capture).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(capture).toHaveBeenCalledOnce();

    clear();
    const completed = vi.fn();
    const clearCompleted = scheduleDeadlineDiagnostics(completed, 180_000);
    clearCompleted();
    vi.advanceTimersByTime(180_000);
    expect(completed).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('keeps an unread stderr producer blocked until failure diagnostics are requested', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.stdout.write('started\\n'); process.stderr.write(Buffer.alloc(2 * 1024 * 1024, 'x'), () => process.stdout.write('finished\\n'));",
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const closed = once(child, 'close');
  const started = once(child.stdout, 'data');
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  const observed = observeChild('producer', child);
  try {
    await started;
    await delay(200);
    expect(stdout).not.toContain('finished');
    expect(child.exitCode).toBeNull();
    const captured = observed.capture();
    expect(captured.stderrBufferedBytes).toBeGreaterThan(0);
    expect(captured.stderrFlowing).not.toBe(true);
    expect(captured.stderr).toContain('x');
    expect(captured.stderr.length).toBeLessThanOrEqual(16000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}, 15_000);

it('captures current caller-owned output without replacing its consumers', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.stdout.write('out-' + 'x'.repeat(20000) + '-tail'); process.stderr.write('err-' + 'y'.repeat(20000) + '-tail');",
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const closed = once(child, 'close');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const observed = observeChild('owned consumers', child, () => ({ stdout, stderr }));
  try {
    await closed;
    expect(child.exitCode).toBe(0);
    expect(stdout).toBe(`out-${'x'.repeat(20000)}-tail`);
    expect(stderr).toBe(`err-${'y'.repeat(20000)}-tail`);
    expect(observed.capture()).toMatchObject({
      stdout: stdout.slice(-16000),
      stderr: stderr.slice(-16000),
      stdoutBufferedBytes: 0,
      stderrBufferedBytes: 0,
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}, 15_000);
