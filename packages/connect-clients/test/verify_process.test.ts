import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { expect, it } from 'vitest';
import { createVerificationProcessHost } from '../src/verify_process.js';

function connect(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: endpoint, allowHalfOpen: true });
    socket.once('error', reject);
    socket.once('connect', () => resolve(socket));
  });
}

function consume(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks)));
  });
}

it('rejects unauthenticated, malformed and incomplete pairs without launching a server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-verify-auth-'));
  const marker = join(root, 'spawned');
  const host = await createVerificationProcessHost(
    process.execPath,
    ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
    getDefaultEnvironment(),
  );
  const sockets: Socket[] = [];
  try {
    for (const [token, channels] of [
      ['0'.repeat(64), ['0', '1']],
      [host.token, ['0', '2']],
    ] as const) {
      const id = randomBytes(16).toString('hex');
      const pair = await Promise.all(channels.map(() => connect(host.endpoint)));
      sockets.push(...pair);
      const closed = pair.map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.on('error', () => undefined);
            socket.once('end', () => socket.destroy());
            socket.once('close', () => resolve());
          }),
      );
      pair.forEach((socket, index) => {
        socket.write(`${token}:${id}:${channels[index]}\n`);
      });
      await closed[1];
      expect(existsSync(marker)).toBe(false);
      for (const socket of pair) socket.destroy();
      await Promise.all(closed);
    }
    const partial = await connect(host.endpoint);
    sockets.push(partial);
    partial.write(`${host.token}:${'a'.repeat(32)}:0\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await host.close();
    expect(existsSync(marker)).toBe(false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves split headers, coalesced protocol bytes and independent stderr with early EOF', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-verify-pipes-'));
  const marker = join(root, 'pid');
  const host = await createVerificationProcessHost(
    process.execPath,
    [
      '-e',
      `
require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));
process.stderr.end(Buffer.alloc(256*1024,101));
process.stdin.pipe(process.stdout);
`,
    ],
    getDefaultEnvironment(),
  );
  let data: Socket | undefined;
  let stderr: Socket | undefined;
  try {
    const id = randomBytes(16).toString('hex');
    data = await connect(host.endpoint);
    stderr = await connect(host.endpoint);
    const received = Promise.all([consume(data), consume(stderr)]);
    received.catch(() => undefined);
    const header = Buffer.from(`${host.token}:${id}:0\n`);
    const payload = Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index % 251));
    data.write(header.subarray(0, 7));
    data.write(header.subarray(7, 83));
    data.end(Buffer.concat([header.subarray(83), payload]));
    stderr.write(`${host.token}:${id}:1\n`);
    const [output, errors] = await received;
    expect(output).toEqual(payload);
    expect(errors).toEqual(Buffer.alloc(256 * 1024, 101));
    const pid = Number(readFileSync(marker, 'utf8'));
    await host.close();
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  } finally {
    data?.destroy();
    stderr?.destroy();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
