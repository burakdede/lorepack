import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openReadOnly } from '@lorepack/backend-local';
import type { BuildId, BuildSummary } from '@lorepack/core';
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
    return `Nothing to remove. ${plan.keep.length} builds retained.`;
  }
  const lines = [`Removing ${plan.remove.length} builds, keeping ${plan.keep.length}:`, ''];
  for (const id of plan.remove) lines.push(`  - ${id}`);
  lines.push('', `  ${plan.objectsToRemove.length} unreferenced objects`);
  lines.push(`  about ${Math.round(plan.bytesFreed / 1024)} KB freed`);
  return lines.join('\n');
}

function objectHashesOf(loreDirectory: string, buildId: BuildId): string[] {
  const path = join(buildDirectory(loreDirectory, buildId), 'context.sqlite');
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
