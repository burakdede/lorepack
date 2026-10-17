import { type ChildProcess, execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoreError } from '@lorepack/core';
import spawn from 'cross-spawn';

const GRACE_MS = 2000;
const HEADER_BYTES = 100;
export const VERIFY_TOKEN_ENV = 'LOREPACK_VERIFY_TOKEN';

interface Session {
  data?: Socket;
  stderr?: Socket;
  child?: ChildProcess;
  exited?: Promise<void>;
  starting?: Promise<void>;
  release?: () => void;
  stopped?: Promise<void>;
}

export interface VerificationProcessHost {
  readonly endpoint: string;
  readonly token: string;
  close(): Promise<void>;
}

export function verificationBridgeEntry(): string {
  const sibling = new URL('./verify_bridge.js', import.meta.url);
  if (existsSync(sibling)) return fileURLToPath(sibling);
  const compiled = new URL('../dist/verify_bridge.js', import.meta.url);
  if (existsSync(compiled)) return fileURLToPath(compiled);
  throw new LoreError('LORE_E_INTERNAL', 'The connection verification helper is missing.', {
    remediation: 'Reinstall Lorepack. From a checkout, run `pnpm build` first.',
    subject: 'verify_bridge.js',
  });
}

async function settles(promise: Promise<void>, timeout: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new LoreError(
      'LORE_E_INTERNAL',
      `Could not inspect verification group ${pid}: ${(error as Error).message}`,
      {
        remediation: 'Check that the verification process can inspect its own server children.',
        cause: error,
      },
    );
  }
}

async function waitForGroup(pid: number): Promise<boolean> {
  const deadline = Date.now() + GRACE_MS;
  while (groupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !groupAlive(pid);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      throw new LoreError(
        'LORE_E_INTERNAL',
        `Could not send ${signal} to verification group ${pid}: ${(error as Error).message}`,
        { remediation: 'Stop the reported verification server before reconnecting.', cause: error },
      );
  }
}

async function killWindowsTree(pid: number): Promise<void> {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (root === undefined || !isAbsolute(root)) {
    throw new LoreError('LORE_E_INTERNAL', 'Windows SystemRoot is missing or relative.', {
      remediation: 'Restore the Windows SystemRoot environment variable before connecting.',
    });
  }
  await new Promise<void>((resolve, reject) => {
    execFile(
      join(root, 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 256 * 1024,
      },
      (error) => (error === null ? resolve() : reject(error)),
    );
  });
}

async function reap(session: Session, graceful: boolean): Promise<void> {
  const child = session.child;
  if (child === undefined || session.exited === undefined) return;
  child.stdin?.end();
  const exited = graceful
    ? await settles(session.exited, GRACE_MS)
    : child.exitCode !== null || child.signalCode !== null;
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    if (!exited) {
      try {
        await killWindowsTree(child.pid);
      } catch (error) {
        if (!(await settles(session.exited, 0))) throw error;
      }
    }
    if (!(await settles(session.exited, GRACE_MS)))
      throw new LoreError(
        'LORE_E_INTERNAL',
        `The verification server ${child.pid} did not exit after process-tree cleanup.`,
        { remediation: 'Stop the reported verification server before reconnecting.' },
      );
  } else if (groupAlive(child.pid)) {
    signalGroup(child.pid, 'SIGTERM');
    if (!(await waitForGroup(child.pid))) {
      signalGroup(child.pid, 'SIGKILL');
      if (!(await waitForGroup(child.pid)))
        throw new LoreError(
          'LORE_E_INTERNAL',
          `The verification process group ${child.pid} did not exit.`,
          {
            remediation: 'Stop the reported verification server before reconnecting.',
          },
        );
    }
    await session.exited;
  }
}

/** Own the real server children even when the SDK disposes its hidden probe bridge. */
export async function createVerificationProcessHost(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<VerificationProcessHost> {
  const token = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(token);
  const directory = process.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'lv-'));
  const endpoint =
    directory === undefined
      ? `\\\\.\\pipe\\lorepack-verify-${process.pid}-${randomBytes(16).toString('hex')}`
      : join(directory, 's');
  const sessions = new Map<string, Session>();
  const sockets = new Set<Socket>();
  const failures: unknown[] = [];
  let closing = false;
  let closingPromise: Promise<void> | undefined;
  let queue: Promise<void> = Promise.resolve();
  const stop = (session: Session, graceful = true) => {
    session.stopped ??= (async () => {
      try {
        await session.starting;
      } finally {
        await reap(session, graceful);
      }
    })().finally(() => {
      session.data?.destroy();
      session.stderr?.destroy();
      session.release?.();
    });
    return session.stopped;
  };
  const start = (session: Session) => {
    if (
      closing ||
      session.stopped !== undefined ||
      session.data === undefined ||
      session.stderr === undefined
    )
      return;
    const child = spawn(command, [...args], {
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: process.platform === 'win32',
    });
    session.child = child;
    session.exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => {
        if (child.pid === undefined) resolve();
        session.data?.destroy();
        session.stderr?.destroy();
      });
    });
    child.stdin?.on('error', () => session.data?.destroy());
    if (child.stdin !== null) session.data.pipe(child.stdin);
    child.stdout?.pipe(session.data);
    child.stderr?.pipe(session.stderr);
  };
  const launch = (session: Session) => {
    const previous = queue;
    const lifetime = new Promise<void>((resolve) => {
      session.release = resolve;
    });
    queue = previous.then(() => lifetime);
    session.starting = previous.then(() => start(session));
    session.starting.catch((error: unknown) => {
      failures.push(error);
      stop(session, false).catch((failure: unknown) => failures.push(failure));
    });
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    if (closing) {
      socket.destroy();
      return;
    }
    const header = Buffer.alloc(HEADER_BYTES);
    let offset = 0;
    const timeout = setTimeout(() => socket.destroy(), GRACE_MS);
    socket.once('close', () => clearTimeout(timeout));
    const readHeader = (chunk: Buffer) => {
      const copied = Math.min(chunk.length, HEADER_BYTES - offset);
      chunk.copy(header, offset, 0, copied);
      offset += copied;
      if (offset !== HEADER_BYTES) return;
      clearTimeout(timeout);
      socket.pause();
      socket.off('data', readHeader);
      const text = header.toString('utf8');
      if (
        closing ||
        !/^[a-f0-9]{64}:[a-f0-9]{32}:[01]\n$/.test(text) ||
        !timingSafeEqual(header.subarray(0, 64), tokenBytes)
      ) {
        socket.destroy();
        return;
      }
      const id = text.slice(65, 97);
      const channel = text[98] === '0' ? 'data' : 'stderr';
      if (channel === 'stderr' && copied < chunk.length) {
        socket.destroy();
        return;
      }
      const session = sessions.get(id) ?? {};
      if (session[channel] !== undefined || session.stopped !== undefined) {
        socket.destroy();
        return;
      }
      session[channel] = socket;
      sessions.set(id, session);
      socket.once('close', () => {
        if (session.starting === undefined) {
          sessions.delete(id);
          session.data?.destroy();
          session.stderr?.destroy();
        } else if (channel === 'data') {
          stop(session).catch((error: unknown) => failures.push(error));
        } else {
          stop(session, false).catch((error: unknown) => failures.push(error));
        }
      });
      if (channel === 'stderr') {
        socket.once('end', () => {
          stop(session, false).catch((error: unknown) => failures.push(error));
        });
        socket.on('data', () => socket.destroy());
        socket.resume();
      }
      if (copied < chunk.length) socket.unshift(chunk.subarray(copied));
      if (session.data !== undefined && session.stderr !== undefined) launch(session);
    };
    socket.on('data', readHeader);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  server.on('error', (error) => failures.push(error));
  return {
    endpoint,
    token,
    close() {
      closingPromise ??= (async () => {
        closing = true;
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.all(
          [...sessions.values()].map((session) =>
            stop(session).catch((error: unknown) => failures.push(error)),
          ),
        );
        for (const socket of sockets) socket.destroy();
        await closed;
        if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
        if (failures.length > 0)
          throw new LoreError(
            'LORE_E_INTERNAL',
            `Verification could not confirm server process cleanup: ${failures.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`,
            {
              remediation: 'Stop the verification server before reconnecting.',
              cause: failures[0],
            },
          );
      })();
      return closingPromise;
    },
  };
}
