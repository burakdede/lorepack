import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { LoreError } from '@lorepack/core';

/**
 * Atomic filesystem helpers. A build that is interrupted at any point must leave either
 * nothing or a complete directory, never a half-written one that a later run might treat
 * as valid (architecture sections 19.3 and 6.9).
 *
 * The pattern is always: write to a temporary name on the same filesystem, fsync the
 * file, rename into place, then fsync the parent directory so the rename itself is
 * durable.
 */

/**
 * Directory fsync is a POSIX guarantee. Windows has no equivalent and rejects the handle,
 * so the call is best effort there. Rename on Windows is atomic within a volume, which is
 * the property we actually depend on.
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

let counter = 0;
function randomSuffix(): string {
  counter += 1;
  return `${counter.toString(36)}${Math.trunc(performance.now() * 1000).toString(36)}`;
}

export interface CandidateDirectory {
  readonly path: string;
}

/**
 * A candidate build lives outside `builds/` until it is sealed, so an interrupted build
 * cannot be mistaken for a real one. `.lore/tmp` is on the same filesystem as `builds/`,
 * which is what makes the final rename atomic rather than a copy.
 */
export function createCandidateDirectory(loreDirectory: string): CandidateDirectory {
  const temporaryRoot = join(loreDirectory, 'tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  return { path: mkdtempSync(join(temporaryRoot, 'candidate-')) };
}

export function discardCandidateDirectory(candidate: CandidateDirectory): void {
  rmSync(candidate.path, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Moves a validated candidate into its final home. Sealing an id that already exists is a
 * no-op rather than an error: builds are content-addressed, so an identical id means
 * identical logical content.
 */
export function sealCandidateDirectory(
  candidate: CandidateDirectory,
  destination: string,
): { sealed: boolean } {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  fsyncDirectory(candidate.path);

  try {
    renameSync(candidate.path, destination);
  } catch (cause) {
    if (isAlreadyExists(cause)) {
      discardCandidateDirectory(candidate);
      return { sealed: false };
    }
    throw new LoreError('LORE_E_INTERNAL', `Could not seal a build into ${destination}.`, {
      remediation: 'Check free space and that no other process holds the directory.',
      cause,
    });
  }
  fsyncDirectory(parent);
  return { sealed: true };
}

function isAlreadyExists(cause: unknown): boolean {
  const code = (cause as { code?: string } | null)?.code;
  // POSIX reports ENOTEMPTY or EEXIST; Windows reports EPERM or EACCES for the same case.
  return code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM' || code === 'EACCES';
}
