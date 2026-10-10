import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fsyncDirectory, LoreError, mkdirOwnerOnly } from '@lorepack/core';

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
  mkdirOwnerOnly(temporaryRoot);
  return { path: mkdtempSync(join(temporaryRoot, CANDIDATE_PREFIX)) };
}

const CANDIDATE_PREFIX = 'candidate-';

/**
 * Removes candidates that builds killed before sealing left behind, returning how many.
 *
 * Callers hold the project lock: a build holds it from creating its candidate until it seals,
 * so under the lock every candidate belongs to a build that is no longer running. Without a
 * sweep they survived every later build and prune, a megabyte or more each (#572). Only
 * `candidate-*` directories are touched.
 */
export function sweepCandidateDirectories(loreDirectory: string): number {
  const temporaryRoot = join(loreDirectory, 'tmp');
  if (!existsSync(temporaryRoot)) return 0;
  let removed = 0;
  for (const entry of readdirSync(temporaryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(CANDIDATE_PREFIX)) continue;
    discardCandidateDirectory({ path: join(temporaryRoot, entry.name) });
    removed += 1;
  }
  return removed;
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
  mkdirOwnerOnly(parent);
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
