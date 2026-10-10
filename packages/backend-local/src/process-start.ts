import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Which process a pid currently names, so a lock can tell its owner from a stranger that was
 * handed the same pid after the owner died (#565).
 *
 * The identity is an opaque string compared only by `sameProcessStart`. Linux reports the
 * start as clock ticks since boot, compared exactly: converting it to wall time needs the boot
 * time, which the kernel recomputes when the clock is stepped, so a converted value can drift
 * by minutes for a process that never restarted. Elsewhere the operating system records the
 * start as wall time when the process is created, and the owner records its own start as
 * `performance.timeOrigin`, so the two are compared within a tolerance that covers the
 * one-second resolution of `ps` and the time Node takes to start.
 *
 * Every probe returns null rather than guessing when it cannot answer, and a caller treats
 * null as "cannot tell", which keeps a live owner's lock.
 */

const LINUX = 'linux:';
const EPOCH = 'epoch:';
const EPOCH_TOLERANCE_MS = 5_000;
const PROBE_TIMEOUT_MS = 15_000;

/** The start identity of the running process, without spawning anything. */
export function ownProcessStart(): string {
  if (process.platform === 'linux') {
    const ticks = linuxStartTicks('self');
    if (ticks !== null) return `${LINUX}${ticks}`;
  }
  return `${EPOCH}${Math.round(performance.timeOrigin)}`;
}

/** The start identity of another process, or null when it is gone or cannot be inspected. */
export function processStart(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    const ticks = linuxStartTicks(String(pid));
    return ticks === null ? null : `${LINUX}${ticks}`;
  }
  const epoch = process.platform === 'win32' ? windowsStartMs(pid) : psStartMs(pid);
  return epoch === null ? null : `${EPOCH}${epoch}`;
}

/** False only when the two identities provably name different processes. */
export function sameProcessStart(recorded: string, observed: string): boolean {
  if (recorded.startsWith(LINUX) && observed.startsWith(LINUX)) return recorded === observed;
  if (recorded.startsWith(EPOCH) && observed.startsWith(EPOCH)) {
    const a = Number(recorded.slice(EPOCH.length));
    const b = Number(observed.slice(EPOCH.length));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
    return Math.abs(a - b) <= EPOCH_TOLERANCE_MS;
  }
  return true;
}

function linuxStartTicks(pid: string): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name is field 2, in parentheses, and may itself contain spaces or
    // parentheses, so fields are counted from the last closing parenthesis. Field 22 is the
    // start time, the 20th after it.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = fields[19];
    return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function psStartMs(pid: number): number | null {
  try {
    // The C locale and UTC fix the format, so the value does not depend on the user's
    // language or time zone. Example: `Tue Sep 29 14:59:44 2026`.
    const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT_MS,
    }).trim();
    const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(output);
    if (match === null) return null;
    const [, month, day, hours, minutes, seconds, year] = match;
    const monthIndex = MONTHS.indexOf(month ?? '');
    if (monthIndex < 0) return null;
    return Date.UTC(
      Number(year),
      monthIndex,
      Number(day),
      Number(hours),
      Number(minutes),
      Number(seconds),
    );
  } catch {
    return null;
  }
}

function windowsStartMs(pid: number): number | null {
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
    ).trim();
    return /^\d+$/.test(output) ? Number(output) : null;
  } catch {
    return null;
  }
}
