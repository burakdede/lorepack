import { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { WorkerOptions } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { serializeError } from '../src/isolation-protocol.js';
import {
  createLinuxResidentReader,
  type LinuxReaderData,
  type LinuxReaderRequest,
} from '../src/linux_resident_reader.js';
import { monitorResidentMemory, type ResidentMemoryMonitor } from '../src/resident_memory.js';

const drivers = vi.hoisted(
  () =>
    [] as {
      data: LinuxReaderData;
      exit(): void;
      restoreService(): void;
    }[],
);
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    Worker: class extends EventEmitter {
      constructor(_entry: URL, options: WorkerOptions) {
        super();
        const data = options.workerData as LinuxReaderData;
        data.port.postMessage({ kind: 'ready', generation: data.generation });
        const service = (request: LinuxReaderRequest) => {
          if (request.kind === 'stop') {
            data.port.postMessage({ kind: 'closed', generation: data.generation });
            data.port.close();
            this.emit('exit', 0);
          } else data.port.postMessage({ ...request, generation: data.generation });
        };
        drivers.push({
          data,
          exit: () => this.emit('exit', 1),
          restoreService: () => {
            data.port.off('message', service);
            data.port.on('message', service);
          },
        });
        data.port.on('message', service);
      }
      async terminate() {
        this.emit('exit', 0);
        return 0;
      }
    },
  };
});
const monitors: ResidentMemoryMonitor[] = [];
afterEach(async () => {
  for (const driver of drivers) driver.restoreService();
  for (const monitor of monitors.splice(0)) {
    monitor.stop();
    await monitor.closed;
  }
  for (const driver of drivers.splice(0)) driver.data.port.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup() {
  const parser = new ChildProcess();
  Object.defineProperty(parser, 'pid', { value: process.pid });
  const kill = vi.spyOn(parser, 'kill').mockReturnValue(true);
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  const monitor = monitorResidentMemory(parser, 1024, (pid, limit, callbacks) =>
    createLinuxResidentReader(
      pid,
      limit,
      callbacks,
      new URL('../dist/linux_resident_reader_worker.js', import.meta.url),
      `${pid}:1`,
    ),
  );
  monitors.push(monitor);
  const driver = drivers.at(-1);
  if (driver === undefined) throw new Error('Reader protocol driver missing.');
  return { monitor, driver, kill, state: new BigInt64Array(driver.data.shared) };
}

it('holds queued healthy readiness until a published terminal cause arrives', async () => {
  const { monitor, driver, kill, state } = setup();
  Atomics.store(state, 0, 1024n);
  Atomics.store(state, 1, 1n);
  driver.data.port.postMessage({ kind: 'sample', generation: driver.data.generation });
  Atomics.store(state, 2, 1n);
  let ready = false;
  const rejection = monitor.ready.catch((error: unknown) => error);
  void monitor.ready.then(
    () => {
      ready = true;
    },
    () => {},
  );
  const settling = monitor.settle();
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(monitor.state.bytes).toBeNull();
  const original = Object.assign(new Error('native failure', { cause: new Error('root cause') }), {
    code: 'EIO',
  });
  driver.data.port.postMessage({
    kind: 'terminal',
    generation: driver.data.generation,
    error: serializeError(original),
  });
  await settling;
  expect(await rejection).toMatchObject({
    code: 'LORE_E_PARSE_FAILED',
    cause: { message: 'native failure', code: 'EIO', cause: { message: 'root cause' } },
  });
  expect(kill).toHaveBeenCalledWith('SIGKILL');
});

it('retains published terminal detail when stop precedes its message delivery', async () => {
  const { monitor, driver, state } = setup();
  const rejection = monitor.ready.catch((error: unknown) => error);
  Atomics.store(state, 2, 1n);
  monitor.stop();
  driver.data.port.postMessage({
    kind: 'terminal',
    generation: driver.data.generation,
    error: serializeError(new Error('retained terminal')),
  });
  await monitor.closed;
  expect(await rejection).toMatchObject({ cause: { message: 'retained terminal' } });
  await monitor.settle();
});

it('keeps an old generation separate from a new reader readiness barrier', async () => {
  const first = setup();
  const ignored = first.monitor.ready.catch(() => undefined);
  first.monitor.stop();
  await first.monitor.closed;
  const next = setup();
  expect(next.driver.data.generation).not.toBe(first.driver.data.generation);
  next.driver.data.port.postMessage({
    kind: 'terminal',
    generation: first.driver.data.generation,
    error: serializeError(new Error('old generation')),
  });
  Atomics.store(next.state, 0, 2048n);
  Atomics.store(next.state, 1, 1n);
  next.driver.data.port.postMessage({ kind: 'sample', generation: next.driver.data.generation });
  await next.monitor.ready;
  await next.monitor.settle();
  expect(next.monitor.state).toMatchObject({ bytes: 2048, error: null, exceeded: false });
  void ignored;
});

it('fails closed after genuinely unanswered 250 ms reader settlement', async () => {
  const { monitor, driver, kill } = setup();
  driver.data.port.removeAllListeners('message');
  const rejection = monitor.ready.catch((error: unknown) => error);
  const started = performance.now();
  await monitor.settle();
  expect(performance.now() - started).toBeGreaterThanOrEqual(250);
  expect(await rejection).toMatchObject({
    code: 'LORE_E_PARSE_FAILED',
    cause: { message: 'Linux resident-memory reader stopped responding for 250 ms.' },
  });
  expect(kill).toHaveBeenCalledWith('SIGKILL');
  await monitor.closed;
});

it('drains an already queued response after a parent stall before declaring loss', async () => {
  const { monitor, driver, kill } = setup();
  driver.data.port.removeAllListeners('message');
  const request = once(driver.data.port, 'message');
  const settling = monitor.settle();
  const [barrier] = await request;
  driver.data.port.postMessage(barrier);
  const started = performance.now();
  while (performance.now() - started < 500) {}
  await settling;
  driver.restoreService();
  monitor.stop();
  await monitor.closed;
  expect(monitor.state.error).toBeNull();
  expect(kill).not.toHaveBeenCalled();
});

it('preserves natural disappearance even when the owned process still appears alive', async () => {
  const { monitor, driver, kill, state } = setup();
  Atomics.store(state, 2, 3n);
  driver.data.port.postMessage({ kind: 'terminal', generation: driver.data.generation });
  await monitor.settle();
  await monitor.closed;
  expect(monitor.state.error).toBeNull();
  expect(monitor.state.exceeded).toBe(false);
  expect(kill).not.toHaveBeenCalled();
});

it('fails closed if a stopped worker loses published error detail on exit', async () => {
  const { monitor, driver, kill, state } = setup();
  const rejection = monitor.ready.catch((error: unknown) => error);
  Atomics.store(state, 2, 1n);
  monitor.stop();
  driver.exit();
  await monitor.closed;
  await monitor.settle();
  expect(await rejection).toMatchObject({
    code: 'LORE_E_PARSE_FAILED',
    cause: {
      message: 'Linux resident-memory reader exited (1) before terminal detail was received.',
    },
  });
  expect(kill).toHaveBeenCalledWith('SIGKILL');
});
