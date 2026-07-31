import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { LoreError } from '../errors/lore-error.js';

/**
 * Atomic filesystem primitives.
 *
 * These live in `core` rather than in a storage adapter because they are not about
 * storage: the CLI writes project files with them, the compiler writes reports, and the
 * build store writes databases. The pattern is always the same, and having two
 * implementations of "write without a reader seeing half of it" would be one too many.
 */

/**
 * Directory fsync is a POSIX guarantee. Windows has no equivalent and rejects the handle,
 * so the call is best effort there. Rename within a filesystem is atomic on both, and that
 * is the property the callers actually depend on.
 */
export function fsyncDirectory(directory: string): void {
  let fd: number;
  try {
    fd = openSync(directory, 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Windows and some network filesystems refuse this. Not fatal.
  } finally {
    closeSync(fd);
  }
}

let counter = 0;
function randomSuffix(): string {
  counter += 1;
  return `${counter.toString(36)}${Math.trunc(performance.now() * 1000).toString(36)}`;
}

/** Writes a file so a reader never observes partial content. */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.tmp-${process.pid}-${randomSuffix()}`);
  try {
    writeFileSync(temporary, data);
    const fd = openSync(temporary, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    fsyncDirectory(directory);
  } catch (cause) {
    rmSync(temporary, { force: true });
    throw new LoreError('LORE_E_INTERNAL', `Could not write ${path}.`, {
      remediation: 'Check the directory exists and has free space.',
      cause,
    });
  }
}
