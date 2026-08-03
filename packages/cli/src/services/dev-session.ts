import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type LoadedConfig, LoreError } from '@lorepack/core';

/**
 * The receipt a running `lore dev` leaves, so the session is discoverable rather than
 * guessed at.
 *
 * Architecture 15.3 fixes the file and the preferred port. The reason it exists is that a
 * dev server is the one long-lived thing Lorepack runs, and everything else that wants to
 * talk to it (another command, a connector's generated config, the person who has forgotten
 * which terminal it is in) otherwise has to scan ports and hope.
 *
 * A receipt is evidence, not a lock. The process it names may be gone, and a file left
 * behind by a machine that lost power must not stop the next session from starting. So it
 * carries a pid and is always checked against reality before it is believed.
 */

export const DEV_PORT = 43110;
export const DEV_RECEIPT = 'dev.json';

export interface DevReceipt {
  readonly port: number;
  readonly pid: number;
  /** ISO 8601, for a person reading the file rather than for any comparison. */
  readonly startedAt: string;
  readonly buildId: string;
  readonly host: string;
}

function receiptPath(config: LoadedConfig): string {
  return join(config.projectRoot, '.lore', DEV_RECEIPT);
}

/**
 * Written atomically, because a reader may arrive mid-write.
 *
 * A truncated receipt is worse than none: it names a port that is half a number, and the
 * reader has no way to tell that from a session on a strange port. Rename is the one
 * operation that is atomic on every filesystem this runs on.
 */
export function writeReceipt(config: LoadedConfig, receipt: DevReceipt): void {
  const path = receiptPath(config);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

export function readReceipt(config: LoadedConfig): DevReceipt | null {
  const path = receiptPath(config);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DevReceipt>;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return null;
    return {
      port: parsed.port,
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      buildId: typeof parsed.buildId === 'string' ? parsed.buildId : '',
      host: typeof parsed.host === 'string' ? parsed.host : '127.0.0.1',
    };
  } catch {
    // Unreadable or not JSON is the same as absent: it cannot be believed, and refusing to
    // start because of a corrupt file would make a crash unrecoverable without `rm`.
    return null;
  }
}

export function removeReceipt(config: LoadedConfig): void {
  rmSync(receiptPath(config), { force: true });
}

/**
 * Whether the process a receipt names is still there.
 *
 * Signal `0` performs the permission and existence checks without delivering anything,
 * which is the portable way to ask. `EPERM` means the process exists and belongs to someone
 * else, which still counts as running.
 */
export function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

/**
 * Refuses a second supervisor on the same project, and clears a receipt whose process died.
 *
 * Two supervisors on one project is not a race worth winning. They would both watch, both
 * rebuild, and take turns failing to acquire the build lock, and the user would see a
 * server that intermittently stalls for reasons nothing explains. Refusing with the port of
 * the session that already exists is more useful than either of them starting.
 */
export function assertNoLiveSession(config: LoadedConfig): void {
  const receipt = readReceipt(config);
  if (receipt === null) return;

  if (!isRunning(receipt.pid)) {
    // Stale: the machine restarted, or the process was killed hard enough that it could not
    // clean up. Nothing to report, because nothing is wrong.
    removeReceipt(config);
    return;
  }

  throw new LoreError(
    'LORE_E_LOCK_HELD',
    `A dev session for this project is already running on http://${receipt.host}:${receipt.port} (pid ${receipt.pid}).`,
    {
      remediation: `Use the session that is already running, or stop it first. If that process is gone, delete .lore/${DEV_RECEIPT}.`,
      subject: String(receipt.pid),
    },
  );
}
