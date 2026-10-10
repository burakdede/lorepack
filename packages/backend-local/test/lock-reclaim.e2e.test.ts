import { type ChildProcess, fork, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Stale-lock reclaim across real processes (#565).
 *
 * Eight processes find the same lock left by a dead owner and race to reclaim it. Before the
 * fix each one decided "stale", re-read and removed whatever lock directory existed by then,
 * which could be the lock another reclaimer had just taken, so two or three held the project
 * lock at once in a third of trials. Every holder registers itself in a shared directory
 * while it holds the lock, so a second concurrent holder is observed, not inferred.
 *
 * The workers stay alive across rounds and are driven over IPC, so a hundred trials cost a
 * hundred rounds of lock traffic rather than eight hundred process start-ups.
 */

const WORKERS = 8;
const ROUNDS = 100;
const COMPILED_LOCK = join(import.meta.dirname, '..', 'dist', 'lock.js');

const WORKER_SOURCE = `
import { mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
const { ProjectLock } = await import(process.env.LOCK_MODULE);
process.on('message', async ({ lockPath, holders }) => {
  try {
    const lock = new ProjectLock(lockPath, { waitMs: 20_000, pollIntervalMs: 1 });
    await lock.acquire();
    const mine = join(holders, String(process.pid));
    mkdirSync(mine);
    const seen = readdirSync(holders).length;
    await new Promise((resolve) => setTimeout(resolve, 3));
    const seenLater = readdirSync(holders).length;
    rmdirSync(mine);
    lock.release();
    process.send({ seen: Math.max(seen, seenLater) });
  } catch (error) {
    process.send({ error: String(error?.stack ?? error) });
  }
});
process.send({ ready: true });
`;

let scratch: string;
let workers: ChildProcess[] = [];

function deadPid(): number {
  // A pid that certainly belonged to a process that has exited.
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return child.pid ?? 999_999;
}

interface WorkerMessage {
  readonly ready?: boolean;
  readonly seen?: number;
  readonly error?: string;
}

function nextMessage(worker: ChildProcess): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null) => reject(new Error(`lock worker exited with ${code}`));
    worker.once('exit', onExit);
    worker.once('message', (message) => {
      worker.off('exit', onExit);
      resolve(message as WorkerMessage);
    });
  });
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'lorepack-lockrace-'));
  const script = join(scratch, 'worker.mjs');
  writeFileSync(script, WORKER_SOURCE, 'utf8');
  workers = Array.from({ length: WORKERS }, () =>
    fork(script, [], {
      env: { ...process.env, LOCK_MODULE: pathToFileURL(COMPILED_LOCK).href },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }),
  );
  await Promise.all(workers.map(nextMessage));
});

afterAll(() => {
  for (const worker of workers) worker.kill();
  rmSync(scratch, { recursive: true, force: true });
});

describe('reclaiming a stale lock from several processes at once', () => {
  it(`never lets two processes hold the lock, over ${ROUNDS} rounds of ${WORKERS}`, async () => {
    const pid = deadPid();
    const maxima: number[] = [];
    const errors: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const lore = join(scratch, `round-${round}`, '.lore');
      const lockPath = join(lore, 'lock');
      const holders = join(scratch, `round-${round}`, 'holders');
      mkdirSync(lockPath, { recursive: true });
      mkdirSync(holders);
      writeFileSync(
        join(lockPath, 'owner.json'),
        JSON.stringify({
          pid,
          hostname: hostname(),
          start: 'epoch:0',
          acquiredAt: Date.now(),
          token: randomUUID(),
        }),
      );

      const results = workers.map(nextMessage);
      for (const worker of workers) worker.send({ lockPath, holders });
      const messages = await Promise.all(results);
      errors.push(...messages.flatMap((message) => message.error ?? []));
      maxima.push(Math.max(...messages.map((message) => message.seen ?? 0)));
    }
    // One assertion, so a failure reports both how many held the lock and what broke.
    expect({ maxConcurrentHolders: Math.max(...maxima), errors }).toEqual({
      maxConcurrentHolders: 1,
      errors: [],
    });
  }, 300_000);
});
