import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openReadOnly } from '@lorepack/backend-local';
import type { PreviousBuild } from '@lorepack/compiler';
import { assertBuildId, type BuildId, LORE_DIRECTORY, type LoadedConfig } from '@lorepack/core';

/**
 * Reads what the active build recorded, so a plan can compare against it.
 *
 * Every read here is read-only, including the state database. `lore plan` and `lore status`
 * must not write, not even a migration, or they would stop being previews. A project that
 * has never been built has no state database at all, which is the case a new user hits, so
 * absence is a normal answer rather than an error.
 */
export interface ProjectState {
  readonly state: { close: () => void } | null;
  readonly previous: PreviousBuild | null;
}

export function readPreviousBuild(config: LoadedConfig): ProjectState {
  const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);
  const active = readActiveBuild(loreDirectory);
  if (active === null) return { state: null, previous: null };
  return { state: null, previous: readBuildCatalog(loreDirectory, active.buildId) };
}

/** The active pointer, read without opening the state store for writing. */
export function readActiveBuild(
  loreDirectory: string,
): { buildId: BuildId; generation: number } | null {
  const statePath = join(loreDirectory, 'state.sqlite');
  if (!existsSync(statePath)) return null;

  const db = openReadOnly(statePath);
  try {
    const row = db
      .prepare('SELECT build_id AS buildId, generation FROM active_build WHERE id = 1')
      .get() as { buildId: string | null; generation: number } | undefined;
    if (row === undefined || row.buildId === null) return null;
    return { buildId: assertBuildId(row.buildId), generation: Number(row.generation) };
  } finally {
    db.close();
  }
}

/**
 * Reads the comparison basis out of the sealed build itself rather than a side table.
 *
 * The build is the source of truth (invariant 1), so dirtiness is computed against what
 * the active build actually contains. A summary cached elsewhere could drift from the
 * build it claims to describe, and then `lore status` would confidently lie.
 */
export function readBuildCatalog(loreDirectory: string, buildId: BuildId): PreviousBuild | null {
  const path = join(loreDirectory, 'builds', buildId, 'context.sqlite');
  if (!existsSync(path)) return null;

  const db = openReadOnly(path);
  try {
    const rows = db.prepare('SELECT id, content_hash FROM artifacts').all() as Array<{
      id: string;
      content_hash: string;
    }>;
    const chunks = db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number };
    return {
      buildId,
      artifactHashes: new Map(rows.map((row) => [row.id, row.content_hash])),
      chunkCount: Number(chunks.n),
      capabilities: ['lexical-search', 'structured-context'],
    };
  } finally {
    db.close();
  }
}
