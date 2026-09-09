import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fsyncDirectory, LoreError } from '@lorepack/core';

/**
 * Build directory lifecycle. The generic atomic-write primitives live in `core`, since the
 * CLI and the compiler need them too; what is specific here is how a candidate build
 * becomes a sealed one.
 */

export interface CandidateDirectory {
  readonly path: string;
}

export interface SealDependencies {
  readonly rename?: typeof renameSync;
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
  dependencies: SealDependencies = {},
): { sealed: boolean } {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  fsyncDirectory(candidate.path);

  try {
    (dependencies.rename ?? renameSync)(candidate.path, destination);
  } catch (cause) {
    if (isAlreadyExists(cause, destination)) {
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

function isAlreadyExists(cause: unknown, destination: string): boolean {
  const code = (cause as { code?: string } | null)?.code;
  if (code === 'ENOTEMPTY' || code === 'EEXIST') return true;
  // Windows can report EPERM or EACCES when rename targets an existing directory. Those
  // codes also describe a missing but unwritable destination, which must remain a failure.
  return (code === 'EPERM' || code === 'EACCES') && existsSync(destination);
}
