import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { setImmediate as nextCheckPhase } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { observeHttp } from './support/http_diagnostics.js';

it('records the socket of a real failed POST without changing its error or listeners', async () => {
  let resets = 0;
  const server = createServer((request, response) => {
    if (request.url === '/reset?secret=hidden-query') {
      resets += 1;
      request.socket.resetAndDestroy();
    } else response.end('healthy');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let baseline: unknown;
  try {
    await fetch(`${origin}/reset?secret=hidden-query`, { method: 'POST', body: 'hidden-body' });
  } catch (error) {
    baseline = error;
  }
  const source = channel('undici:client:sendHeaders');
  const before: unknown[] = [];
  const after: unknown[] = [];
  const listenerCounts = (value: unknown) => {
    const { socket } = value as { socket: Socket };
    return ['error', 'timeout', 'data', 'end', 'close'].map((name) => socket.listenerCount(name));
  };
  const first = (value: unknown) => before.push(listenerCounts(value));
  const last = (value: unknown) => after.push(listenerCounts(value));
  source.subscribe(first);
  const observed = observeHttp(origin);
  source.subscribe(last);
  try {
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${origin}/healthy?secret=hidden-query`, {
        headers: { Authorization: 'hidden-authorization' },
      });
      expect(await response.text()).toBe('healthy');
      await nextCheckPhase();
    }
    let original: unknown;
    try {
      await fetch(`${origin}/reset?secret=hidden-query`, { method: 'POST', body: 'hidden-body' });
    } catch (error) {
      original = error;
    }
    expect(original).toBeInstanceOf(TypeError);
    expect(baseline).toBeInstanceOf(TypeError);
    const cause = (original as Error).cause as NodeJS.ErrnoException;
    const baselineCause = (baseline as Error).cause as NodeJS.ErrnoException;
    expect(cause.code).toBeTruthy();
    expect(cause.code).toBe(baselineCause.code);
    expect(cause.syscall).toBe(baselineCause.syscall);
    expect(resets).toBe(2);
    const captured = observed.capture();
    expect(captured.events).toContainEqual(
      expect.objectContaining({
        event: 'error',
        method: 'POST',
        path: '/reset',
        errorCode: cause.code,
        socketId: expect.any(Number),
        localPort: expect.any(Number),
        remotePort: (server.address() as AddressInfo).port,
        bytesRead: expect.any(Number),
        bytesWritten: expect.any(Number),
      }),
    );
    expect(captured.events).toContainEqual(
      expect.objectContaining({ event: 'send headers', socketUses: 3 }),
    );
    expect(after).toEqual(before);
    expect(server.listenerCount('clientError')).toBe(0);
    expect(server.listenerCount('timeout')).toBe(0);
    expect(JSON.stringify(captured)).not.toMatch(/hidden-query|hidden-authorization|hidden-body/);
  } finally {
    observed.stop();
    source.unsubscribe(first);
    source.unsubscribe(last);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('bounds history, isolates origins and unsubscribes before later real requests', async () => {
  const server = createServer((_request, response) => response.end('healthy'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const observed = observeHttp(origin);
  const unrelated = observeHttp('http://unrelated.invalid');
  try {
    for (let index = 0; index < 30; index += 1) {
      expect(await (await fetch(`${origin}/healthy`)).text()).toBe('healthy');
    }
    const captured = observed.capture();
    expect(captured.events).toHaveLength(64);
    expect(captured.dropped).toBeGreaterThan(0);
    expect(unrelated.capture()).toEqual({ dropped: 0, events: [] });
    observed.stop();
    observed.stop();
    expect(await (await fetch(`${origin}/later`)).text()).toBe('healthy');
    expect(observed.capture()).toEqual(captured);
  } finally {
    observed.stop();
    unrelated.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
