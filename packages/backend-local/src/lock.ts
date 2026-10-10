import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { LoreError } from '@lorepack/core';
import { ownProcessStart, processStart, sameProcessStart } from './process-start.js';

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
  /** The owner's start identity (see `process-start.ts`). Injectable with `ownerPid`. */
  readonly ownerStart?: string;
  /** The machine this process runs on. Injectable so tests can act as another host. */
  readonly hostname?: string;
  /** Start identity of a live pid, or null when it cannot be told. */
  readonly processStart?: (pid: number) => string | null;
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
  /** When the owning process started, so a reused pid is not mistaken for the owner. */
  readonly start: string;
  readonly acquiredAt: number;
  readonly hostname: string;
  readonly token: string;
}

/** What is at the lock path, as far as reclaiming it is concerned. */
type Observed =
  | { readonly kind: 'record'; readonly record: LockRecord }
  | { readonly kind: 'foreign'; readonly pid: number | null; readonly hostname: string }
  | { readonly kind: 'unreadable' };

/**
 * How long a command waits for the lock before reporting it as held.
 *
 * Exported so the value can be asserted rather than duplicated in a test, and so
 * `LORE_LOCK_WAIT_MS` has something to be described against. It is a measure of how long a
 * person will look at a command that appears to be doing nothing, not of how long a build
 * takes: a large project on a slow disk legitimately exceeds it, which is what the
 * environment variable is for (#229).
 */
export const DEFAULT_LOCK_WAIT_MS = 30_000;

const DEFAULTS = {
  staleAfterMs: 5 * 60_000,
  waitMs: DEFAULT_LOCK_WAIT_MS,
  pollIntervalMs: 100,
};

/**
 * How long a reclaimed lock's tombstone is kept.
 *
 * The tombstone is what makes a reclaim happen once: its name is derived from the reclaimed
 * lock, so a second process that judged the same lock stale fails to rename onto it rather
 * than moving whatever lock exists by then. It only has to outlive the gap between a
 * process reading a lock record and renaming the lock, which is synchronous code, so an hour
 * is a margin against a suspended process rather than an estimate.
 */
const TOMBSTONE_RETENTION_MS = 60 * 60_000;
const TOMBSTONE_MARKER = 'reclaimed-at';

/** Tokens are UUIDs this module generated; anything else never reaches a path. */
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  #ownerToken: string | null = null;

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
      ownerStart:
        options.ownerStart ??
        (options.ownerPid === undefined || options.ownerPid === process.pid
          ? ownProcessStart()
          : (processStart(options.ownerPid) ?? '')),
      hostname: options.hostname ?? osHostname(),
      processStart: options.processStart ?? processStart,
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
    const token = randomUUID();
    const record: LockRecord = {
      pid: this.#options.ownerPid,
      start: this.#options.ownerStart,
      acquiredAt: this.#options.now(),
      hostname: this.#options.hostname,
      token,
    };
    writeFileSync(this.#recordPath, JSON.stringify(record), 'utf8');
    this.#held = true;
    this.#ownerToken = token;
    this.#sweepTombstones();
    return true;
  }

  #readOwner(path = this.#recordPath): LockRecord | null {
    const observed = this.#observe(path);
    return observed.kind === 'record' ? observed.record : null;
  }

  #observe(path = this.#recordPath): Observed {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { kind: 'unreadable' };
    }
    if (typeof parsed !== 'object' || parsed === null) return { kind: 'unreadable' };
    const value = parsed as Record<string, unknown>;
    const pid = Number.isSafeInteger(value.pid) ? (value.pid as number) : null;
    // A lock taken on another machine sharing this directory cannot be checked from here,
    // whatever else its record says, so it is reported before it is validated.
    if (typeof value.hostname === 'string' && value.hostname !== this.#options.hostname) {
      return { kind: 'foreign', pid, hostname: value.hostname };
    }
    if (
      pid === null ||
      typeof value.start !== 'string' ||
      typeof value.acquiredAt !== 'number' ||
      typeof value.hostname !== 'string' ||
      typeof value.token !== 'string' ||
      !TOKEN_PATTERN.test(value.token)
    ) {
      return { kind: 'unreadable' };
    }
    return {
      kind: 'record',
      record: {
        pid,
        start: value.start,
        acquiredAt: value.acquiredAt,
        hostname: value.hostname,
        token: value.token,
      },
    };
  }

  /** True when the owner's process has exited, or its pid now names a different process. */
  #ownerIsGone(record: LockRecord, starts: Map<number, string | null>): boolean {
    // A lock this process already holds is a genuine conflict, not a stale one.
    if (record.pid === this.#options.ownerPid) {
      return !sameProcessStart(record.start, this.#options.ownerStart);
    }
    if (!this.#options.isProcessAlive(record.pid)) return true;
    if (!starts.has(record.pid)) starts.set(record.pid, this.#options.processStart(record.pid));
    const observed = starts.get(record.pid) ?? null;
    return observed !== null && !sameProcessStart(record.start, observed);
  }

  /**
   * The name a stale lock is moved to, or null when it must not be reclaimed.
   *
   * A record is identified by its token; a lock without a readable record by the directory's
   * inode, which survives the rename. Both come from what was judged stale, never from what
   * is at the path when the rename runs.
   */
  #staleIdentity(observed: Observed, starts: Map<number, string | null>): string | null {
    if (observed.kind === 'foreign') return null;
    if (observed.kind === 'record') {
      return this.#ownerIsGone(observed.record, starts) ? `token-${observed.record.token}` : null;
    }
    try {
      const stat = statSync(this.#directory, { bigint: true });
      const age = this.#options.now() - Number(stat.mtimeMs);
      return age > this.#options.staleAfterMs ? `inode-${stat.ino}` : null;
    } catch {
      return null;
    }
  }

  /**
   * Moves the judged lock aside, once.
   *
   * Removing "the lock directory" after deciding it is stale removes whatever is there by
   * then, which can be the lock another reclaimer has just taken (#565). A rename onto a name
   * derived from the judged lock either moves that lock or fails: the first reclaimer creates
   * the tombstone, and every later rename onto it fails because the directory is not empty.
   * The moved record is still checked, so a lock that was not the one judged is put back.
   */
  #reclaim(identity: string): boolean {
    const tombstone = `${this.#directory}.reclaimed-${identity}`;
    try {
      renameSync(this.#directory, tombstone);
    } catch {
      return false;
    }
    this.#markTombstone(tombstone);
    if (this.#identityAt(tombstone) === identity) return true;
    try {
      renameSync(tombstone, this.#directory);
    } catch {
      // The path was taken again in the meantime; that lock stands and this one is lost.
    }
    return false;
  }

  #identityAt(directory: string): string | null {
    const record = this.#readOwner(join(directory, 'owner.json'));
    if (record !== null) return `token-${record.token}`;
    try {
      return `inode-${statSync(directory, { bigint: true }).ino}`;
    } catch {
      return null;
    }
  }

  #markTombstone(tombstone: string): void {
    try {
      writeFileSync(join(tombstone, TOMBSTONE_MARKER), String(this.#options.now()), 'utf8');
    } catch {
      // Unmarked tombstones are marked by the next sweep, which delays their removal only.
    }
  }

  /**
   * Removes tombstones past retention. A tombstone without a marker belongs to a reclaim in
   * progress or one that crashed, so it is marked now and removed one retention period later.
   */
  #sweepTombstones(): void {
    const parent = dirname(this.#directory);
    const prefix = `${basename(this.#directory)}.reclaimed-`;
    let entries: string[];
    try {
      entries = readdirSync(parent).filter((name) => name.startsWith(prefix));
    } catch {
      return;
    }
    for (const name of entries) {
      const tombstone = join(parent, name);
      try {
        const marked = statSync(join(tombstone, TOMBSTONE_MARKER)).mtimeMs;
        if (this.#options.now() - marked > TOMBSTONE_RETENTION_MS) {
          rmSync(tombstone, { recursive: true, force: true });
        }
      } catch {
        this.#markTombstone(tombstone);
      }
    }
  }

  async acquire(): Promise<void> {
    // Wall time, deliberately not the injected clock: `now` exists so staleness can be
    // tested with a frozen clock, and a frozen clock must never make this loop unbounded.
    const deadline = Date.now() + this.#options.waitMs;
    // Probing another process's start can spawn `ps`, so it is asked once per pid per wait.
    const starts = new Map<number, string | null>();
    let announced = false;
    for (;;) {
      if (this.#tryAcquire()) return;

      const observed = this.#observe();
      if (!announced) {
        announced = true;
        this.#options.onWait({ pid: observed.kind === 'unreadable' ? null : ownerPid(observed) });
      }

      const identity = this.#staleIdentity(observed, starts);
      if (identity !== null && this.#reclaim(identity)) {
        process.stderr.write(
          `warning: reclaimed a stale lock left by pid ${
            observed.kind === 'record' ? observed.record.pid : 'unknown'
          }.\n`,
        );
        if (this.#tryAcquire()) return;
      }

      if (Date.now() >= deadline) throw heldError(this.#observe());
      await new Promise((resolve) => setTimeout(resolve, this.#options.pollIntervalMs));
    }
  }

  release(): void {
    if (!this.#held) return;
    const owner = this.#readOwner();
    if (owner?.token === this.#ownerToken) {
      rmSync(this.#directory, { recursive: true, force: true });
    }
    this.#held = false;
    this.#ownerToken = null;
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

function ownerPid(observed: Exclude<Observed, { kind: 'unreadable' }>): number | null {
  return observed.kind === 'record' ? observed.record.pid : observed.pid;
}

function heldError(observed: Observed): LoreError {
  if (observed.kind === 'foreign') {
    const who = observed.pid === null ? '' : ` (pid ${observed.pid})`;
    return new LoreError(
      'LORE_E_LOCK_HELD',
      `A Lorepack process${who} on host ${observed.hostname} holds the project lock.`,
      {
        remediation: `Whether it is still running can only be checked on ${observed.hostname}. If no Lorepack process is running there, remove .lore/lock and retry.`,
        details: { pid: observed.pid, hostname: observed.hostname },
      },
    );
  }
  const owner = observed.kind === 'record' ? observed.record : null;
  return new LoreError(
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
