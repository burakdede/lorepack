import { LoreError } from './lore-error.js';

/** SQLite's primary result code for "database or disk is full". */
const SQLITE_FULL = 13;

/**
 * The typed error for a write that failed because storage ran out, or null when `cause` is
 * something else.
 *
 * A full disk is a condition of the machine, not a defect, and the only useful remediation is
 * to free space. Left unmapped it surfaced as `LORE_E_INTERNAL`, inviting a bug report, and
 * from a SQLite transaction it was hidden entirely behind the failed `ROLLBACK` that followed
 * (#572). Both an errno from a file write and SQLite's own result code are recognised, because
 * SQLite reports a full disk without passing the errno through.
 */
export function diskFullError(cause: unknown): LoreError | null {
  if (cause instanceof LoreError) return cause.code === 'LORE_E_DISK_FULL' ? cause : null;
  const { code, errcode } = (cause ?? {}) as { code?: unknown; errcode?: unknown };
  const full =
    code === 'ENOSPC' ||
    code === 'EDQUOT' ||
    (typeof errcode === 'number' && (errcode & 0xff) === SQLITE_FULL);
  if (!full) return null;
  return new LoreError('LORE_E_DISK_FULL', 'The disk is full, so the write did not complete.', {
    remediation: 'Free disk space and retry. Nothing that was already active has changed.',
    cause,
  });
}
