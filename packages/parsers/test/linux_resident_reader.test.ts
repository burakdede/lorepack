import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Worker } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import {
  createLinuxResidentReader,
  readLinuxProcessBirthSync,
} from '../src/linux_resident_reader.js';
import { monitorResidentMemory, type ResidentMemoryMonitor } from '../src/resident_memory.js';

const records = vi.hoisted(
  () => [] as { worker: Worker; shared: SharedArrayBuffer; generation: number }[],
);
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        records.push({
          worker: this,
          shared: args[1]?.workerData.shared,
          generation: args[1]?.workerData.generation,
        });
      }
    },
  };
});

async function nativeCase(
  run: (
    monitor: ResidentMemoryMonitor,
    child: ReturnType<typeof fork>,
    record: (typeof records)[number],
  ) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'lore-linux-read-'));
  const entry = join(directory, 'child.mjs');
  writeFileSync(
    entry,
    `let retained; process.on('message',()=>{setTimeout(()=>{retained=Buffer.alloc(128*1024*1024,1);},150);}); process.send('ready'); setInterval(()=>{},1000);`,
  );
  const child = fork(entry, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = once(child, 'close');
  let monitor: ResidentMemoryMonitor | undefined;
  let original: unknown;
  let ownedRecord: (typeof records)[number] | undefined;
  try {
    await once(child, 'message');
    const pid = child.pid;
    if (pid === undefined) throw new Error('Native child did not start.');
    const started = performance.now();
    const birth = readLinuxProcessBirthSync(pid);
    console.info(JSON.stringify({ nativeBirthReadMs: performance.now() - started }));
    monitor = monitorResidentMemory(child, 64, (ownedPid, limit, callbacks) =>
      createLinuxResidentReader(
        ownedPid,
        limit,
        callbacks,
        new URL('../dist/linux_resident_reader_worker.js', import.meta.url),
        birth,
      ),
    );
    const record = records.at(-1);
    if (record === undefined) throw new Error('Native reader worker was not created.');
    ownedRecord = record;
    await run(monitor, child, record);
  } catch (error) {
    original = error;
    throw error;
  } finally {
    await cleanup();
  }
  async function cleanup() {
    const errors: unknown[] = [];
    try {
      monitor?.stop();
      await monitor?.closed;
    } catch (error) {
      errors.push(error);
    }
    if (ownedRecord !== undefined) {
      try {
        if (ownedRecord.worker.threadId !== -1) await ownedRecord.worker.terminate();
        expect(ownedRecord.worker.threadId).toBe(-1);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    } catch (error) {
      errors.push(error);
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(
        original === undefined ? errors : [original, ...errors],
        'Native fixture cleanup failed.',
        { cause: original },
      );
  }
}

function blockParent() {
  const start = performance.now();
  while (performance.now() - start < 500) {}
  expect(performance.now() - start).toBeGreaterThanOrEqual(500);
}

it.runIf(process.platform === 'linux')(
  'reads a real live child while its owner stalls before initial readiness',
  async () => {
    await nativeCase(async (monitor, child, record) => {
      blockParent();
      const duringStall = Atomics.load(new BigInt64Array(record.shared), 1);
      expect(duringStall).toBeGreaterThan(0n);
      await monitor.ready;
      await monitor.settle();
      expect(record.worker.threadId).toBeGreaterThan(0);
      expect(monitor.state.error).toBeNull();
      expect(monitor.state.exceeded).toBe(false);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      const deadline = performance.now() + 2000;
      while (
        Atomics.load(new BigInt64Array(record.shared), 1) <= duringStall &&
        performance.now() < deadline
      )
        await delay(10);
      expect(Atomics.load(new BigInt64Array(record.shared), 1)).toBeGreaterThan(duringStall);
    });
  },
  15000,
);

it.runIf(process.platform === 'linux')(
  'settles queued healthy reports behind a later real RSS exclusion',
  async () => {
    await nativeCase(async (monitor, child, record) => {
      await monitor.ready;
      const before = Atomics.load(new BigInt64Array(record.shared), 1);
      child.send('allocate');
      blockParent();
      expect(Atomics.load(new BigInt64Array(record.shared), 1)).toBeGreaterThan(before);
      expect(Atomics.load(new BigInt64Array(record.shared), 2)).toBe(2n);
      await monitor.settle();
      expect(monitor.state.exceeded).toBe(true);
      expect(monitor.state.error).toBeNull();
      if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
      const pid = child.pid;
      if (pid === undefined) throw new Error('Native child had no PID.');
      expect(() => process.kill(pid, 0)).toThrow();
    });
  },
  15000,
);

it.runIf(process.platform === 'linux')(
  'fails closed through the owned child when a reader worker abruptly exits',
  async () => {
    await nativeCase(async (monitor, child, record) => {
      await monitor.ready;
      await record.worker.terminate();
      await monitor.settle();
      expect(monitor.state.error).toMatchObject({ code: 'LORE_E_PARSE_FAILED' });
      if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
      const pid = child.pid;
      if (pid === undefined) throw new Error('Native child had no PID.');
      expect(() => process.kill(pid, 0)).toThrow();
    });
  },
  15000,
);
