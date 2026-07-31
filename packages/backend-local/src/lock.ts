import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LoreError } from '@lorepack/core';

/**
 * A narrow cross-process lock for builds and activation.
 *
 * `mkdir` is atomic on every filesystem we support, which is all this needs. Architecture
 * section 8.2 allows "proper-lockfile or an equivalent narrow lock"; the dependency has
 * had no release since 2022, and this is under a hundred lines fully covered by our own
 * cross-platform tests, so the equivalent is preferred over a dormant dependency.
 */

export interface LockOptions {
  /** A lock older than this with a dead owner is reclaimed. */
  readonly staleAfterMs?: number;
  readonly waitMs?: number;
  readonly pollIntervalMs?: number;
  /** Clock used for staleness decisions. The wait deadline always uses wall time. */
  readonly now?: () => number;
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Identity written into the lock record. Injectable so tests can act as another process. */
  readonly ownerPid?: number;
  /**
   * Called once when the lock is not free and this process begins waiting.
   *
   * A build that appears to hang is indistinguishable from a broken one, so the caller
   * gets the chance to say who it is waiting for. The lock itself writes to no stream:
   * the CLI reports through its progress bus, and a server would log it.
   */
  readonly onWait?: (owner: { pid: number | null }) => void;
}

interface LockRecord {
  readonly pid: number;
  readonly acquiredAt: number;
  readonly hostname: string;
}

const DEFAULTS = {
  staleAfterMs: 5 * 60_000,
  waitMs: 30_000,
  pollIntervalMs: 100,
};

function defaultIsProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as { code?: string }).code === 'EPERM';
  }
}

export class ProjectLock {
  readonly #directory: string;
  readonly #recordPath: string;
  readonly #options: Required<LockOptions>;
  #held = false;

  constructor(lockPath: string, options: LockOptions = {}) {
    this.#directory = lockPath;
    this.#recordPath = join(lockPath, 'owner.json');
    this.#options = {
      staleAfterMs: options.staleAfterMs ?? DEFAULTS.staleAfterMs,
      waitMs: options.waitMs ?? DEFAULTS.waitMs,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      now: options.now ?? Date.now,
      isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
      ownerPid: options.ownerPid ?? process.pid,
      onWait: options.onWait ?? (() => {}),
    };
  }

  get held(): boolean {
    return this.#held;
  }

  #tryAcquire(): boolean {
    mkdirSync(dirname(this.#directory), { recursive: true });
    try {
      mkdirSync(this.#directory);
    } catch (cause) {
      if ((cause as { code?: string }).code !== 'EEXIST') throw cause;
      return false;
    }
    const record: LockRecord = {
      pid: this.#options.ownerPid,
      acquiredAt: this.#options.now(),
      hostname: process.env.HOSTNAME ?? 'unknown',
    };
    writeFileSync(this.#recordPath, JSON.stringify(record), 'utf8');
    this.#held = true;
    return true;
  }

  #readOwner(): LockRecord | null {
    try {
      return JSON.parse(readFileSync(this.#recordPath, 'utf8')) as LockRecord;
    } catch {
      return null;
    }
  }

  /** True when the holder is gone, or the record is unreadable and old enough to distrust. */
  #isStale(): boolean {
    const owner = this.#readOwner();
    if (owner === null) {
      try {
        const age = this.#options.now() - statSync(this.#directory).mtimeMs;
        return age > this.#options.staleAfterMs;
      } catch {
        return false;
      }
    }
    // A lock this process already holds is a genuine conflict, not a stale one.
    if (owner.pid === this.#options.ownerPid) return false;
    if (!this.#options.isProcessAlive(owner.pid)) return true;
    return this.#options.now() - owner.acquiredAt > this.#options.staleAfterMs;
  }

  async acquire(): Promise<void> {
    // Wall time, deliberately not the injected clock: `now` exists so staleness can be
    // tested with a frozen clock, and a frozen clock must never make this loop unbounded.
    const deadline = Date.now() + this.#options.waitMs;
    let announced = false;
    for (;;) {
      if (this.#tryAcquire()) return;

      if (!announced) {
        announced = true;
        this.#options.onWait({ pid: this.#readOwner()?.pid ?? null });
      }

      if (this.#isStale()) {
        const owner = this.#readOwner();
        rmSync(this.#directory, { recursive: true, force: true });
        if (this.#tryAcquire()) {
          process.stderr.write(
            `warning: reclaimed a stale lock left by pid ${owner?.pid ?? 'unknown'}.\n`,
          );
          return;
        }
      }

      if (Date.now() >= deadline) {
        const owner = this.#readOwner();
        throw new LoreError(
          'LORE_E_LOCK_HELD',
          owner === null
            ? 'Another Lorepack process holds the project lock.'
            : `Another Lorepack process (pid ${owner.pid}) holds the project lock.`,
          {
            remediation:
              'Wait for it to finish, or stop it. If no Lorepack process is running, remove .lore/lock and retry.',
            details: owner === null ? {} : { pid: owner.pid, acquiredAt: owner.acquiredAt },
          },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.#options.pollIntervalMs));
    }
  }

  release(): void {
    if (!this.#held) return;
    rmSync(this.#directory, { recursive: true, force: true });
    this.#held = false;
  }

  /** Runs the callback under the lock, releasing it even when the callback throws. */
  async withLock<T>(run: () => T | Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await run();
    } finally {
      this.release();
    }
  }
}
