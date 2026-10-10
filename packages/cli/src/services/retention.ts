import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openReadOnly } from '@lorepack/backend-local';
import { type BuildId, type BuildSummary, count } from '@lorepack/core';
import { buildDirectory } from './builds.js';

/**
 * Local retention (architecture section 17.8): keep the active build and the previous five
 * verified builds.
 *
 * A cleanup plan is always produced before anything is removed, and objects referenced by
 * a retained build are never deleted. Retention exists to bound disk use, so deleting
 * something a surviving build still needs would defeat its own purpose.
 */

export const DEFAULT_KEEP_PREVIOUS = 5;

export interface RetentionPlan {
  readonly keep: readonly BuildId[];
  readonly remove: readonly BuildId[];
  readonly objectsToRemove: readonly string[];
  readonly bytesFreed: number;
}

export function planRetention(
  loreDirectory: string,
  builds: readonly BuildSummary[],
  active: BuildId | null,
  keepPrevious: number = DEFAULT_KEEP_PREVIOUS,
): RetentionPlan {
  // Newest first, with the active build pinned regardless of its position in history.
  const ordered = [...builds].sort((a, b) =>
    a.createdAt === b.createdAt
      ? b.buildId.localeCompare(a.buildId)
      : b.createdAt.localeCompare(a.createdAt),
  );

  const keep = new Set<BuildId>();
  if (active !== null) keep.add(active);
  for (const build of ordered) {
    if (keep.size >= keepPrevious + (active === null ? 0 : 1)) break;
    if (build.state === 'failed') continue;
    keep.add(build.buildId);
  }

  const remove = ordered.map((build) => build.buildId).filter((id) => !keep.has(id));

  // Objects are content addressed and shared between builds, so a hash is only removable
  // when no retained build references it.
  const referenced = new Set<string>();
  for (const id of keep) {
    for (const hash of objectHashesOf(loreDirectory, id)) referenced.add(hash);
  }
  const doomed = new Set<string>();
  for (const id of remove) {
    for (const hash of objectHashesOf(loreDirectory, id)) {
      if (!referenced.has(hash)) doomed.add(hash);
    }
  }

  return {
    keep: [...keep],
    remove,
    objectsToRemove: [...doomed].sort(),
    bytesFreed: remove.reduce(
      (sum, id) => sum + directorySize(buildDirectory(loreDirectory, id)),
      0,
    ),
  };
}

/**
 * The part of a previewed plan that is still safe to apply. Callers hold the project lock.
 *
 * The preview was computed without the lock, so a build may have sealed, been activated or
 * been rolled back to since (#564). History is re-read here and a build is removed only if
 * both the preview and a fresh plan remove it, so nothing the user was not shown is deleted.
 * An object is removed only if the preview listed it and no build that survives references
 * it, counting every directory under `builds/` rather than only recorded ones, and any
 * candidate left under `tmp/`. A build reusing an object never re-creates it (`put` is a
 * no-op for an existing hash), so this recheck is the only thing protecting it.
 */
export function reconcileRetention(
  loreDirectory: string,
  preview: RetentionPlan,
  builds: readonly BuildSummary[],
  active: BuildId | null,
  keepPrevious: number,
): RetentionPlan {
  const fresh = new Set(planRetention(loreDirectory, builds, active, keepPrevious).remove);
  const remove = preview.remove.filter((id) => fresh.has(id) && id !== active);
  const removing = new Set<string>(remove);

  const referenced = new Set<string>();
  for (const directory of survivingBuildDirectories(loreDirectory, removing)) {
    for (const hash of objectHashesIn(directory)) referenced.add(hash);
  }

  return {
    keep: builds.map((build) => build.buildId).filter((id) => !removing.has(id)),
    remove,
    objectsToRemove: preview.objectsToRemove.filter((hash) => !referenced.has(hash)),
    bytesFreed: remove.reduce(
      (sum, id) => sum + directorySize(buildDirectory(loreDirectory, id)),
      0,
    ),
  };
}

function survivingBuildDirectories(loreDirectory: string, removing: ReadonlySet<string>): string[] {
  const directories: string[] = [];
  const builds = join(loreDirectory, 'builds');
  if (existsSync(builds)) {
    for (const entry of readdirSync(builds, { withFileTypes: true })) {
      if (entry.isDirectory() && !removing.has(entry.name)) {
        directories.push(join(builds, entry.name));
      }
    }
  }
  // A build holds the lock from creating its candidate until it seals, so under the lock a
  // candidate is one an interrupted build left behind. Its objects are kept anyway: the cost
  // is a few unreclaimed files, and the alternative is reasoning about a build in flight.
  const temporary = join(loreDirectory, 'tmp');
  if (existsSync(temporary)) {
    for (const entry of readdirSync(temporary, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(temporary, entry.name));
    }
  }
  return directories;
}

export function applyRetention(loreDirectory: string, plan: RetentionPlan): void {
  for (const id of plan.remove) {
    rmSync(buildDirectory(loreDirectory, id), { recursive: true, force: true, maxRetries: 3 });
  }
  for (const hash of plan.objectsToRemove) {
    rmSync(objectPath(loreDirectory, hash), { force: true, maxRetries: 3 });
  }
}

export function renderRetentionPlan(plan: RetentionPlan): string {
  if (plan.remove.length === 0) {
    return `Nothing to remove. ${count(plan.keep.length, 'build')} retained.`;
  }
  const lines = [
    `Removing ${count(plan.remove.length, 'build')}, keeping ${plan.keep.length}:`,
    '',
  ];
  for (const id of plan.remove) lines.push(`  - ${id}`);
  lines.push('', `  ${count(plan.objectsToRemove.length, 'unreferenced object')}`);
  lines.push(`  about ${Math.round(plan.bytesFreed / 1024)} KB freed`);
  return lines.join('\n');
}

function objectHashesOf(loreDirectory: string, buildId: BuildId): string[] {
  return objectHashesIn(buildDirectory(loreDirectory, buildId));
}

function objectHashesIn(directory: string): string[] {
  const path = join(directory, 'context.sqlite');
  if (!existsSync(path)) return [];
  const db = openReadOnly(path);
  try {
    return (
      db.prepare('SELECT DISTINCT object_hash FROM artifacts').all() as Array<{
        object_hash: string;
      }>
    ).map((row) => row.object_hash);
  } finally {
    db.close();
  }
}

function objectPath(loreDirectory: string, hash: string): string {
  return join(
    loreDirectory,
    'objects',
    'sha256',
    hash.slice(0, 2),
    hash.slice(2, 4),
    hash.slice(4),
  );
}

function directorySize(directory: string): number {
  if (!existsSync(directory)) return 0;
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    try {
      total += readFileSync(join(entry.parentPath, entry.name)).byteLength;
    } catch {
      // A file that vanished between listing and reading contributes nothing. The figure
      // is an estimate shown to a human, not an accounting record.
    }
  }
  return total;
}
