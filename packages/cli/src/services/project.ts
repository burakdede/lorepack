import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildMigrationsDirectory, loadMigrations, openReadOnly } from '@lorepack/backend-local';
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
/**
 * What the previous build contains, or `null` if it cannot say.
 *
 * **Best effort, deliberately.** This exists to let a rebuild reuse unchanged artifacts, which
 * is an optimisation. A build whose database is missing, truncated or overwritten used to take
 * the *next* build down with it, which is precisely backwards: the command that exists to
 * produce a good build failed because a bad one existed, and the project could not be recovered
 * at all (#251). Returning `null` costs a full rebuild and is always correct.
 */
export function readBuildCatalog(loreDirectory: string, buildId: BuildId): PreviousBuild | null {
  try {
    return readBuildCatalogOrThrow(loreDirectory, buildId);
  } catch {
    // Damaged past the point of being an optimisation. `isBuildReadable` is what turns this
    // into something the user is told about, rather than a silent full rebuild.
    return null;
  }
}

/**
 * Whether a sealed build can actually be read.
 *
 * `state.sqlite` records that a build exists; it says nothing about the directory it points at,
 * which is a separate file tree that a disk, a sync tool or a `.gitignore` miss can remove or
 * corrupt independently. Reuse used to trust the record alone and report "No changes" over a
 * build nobody could open (#251).
 */
export function isBuildReadable(loreDirectory: string, buildId: BuildId): boolean {
  try {
    if (readBuildCatalogOrThrow(loreDirectory, buildId) === null) return false;
    return buildSchemaMatches(loreDirectory, buildId);
  } catch {
    return false;
  }
}

/**
 * Whether the build's catalog schema is the one this binary reads.
 *
 * The same comparison the runtime makes when it opens a build, made here so `lore build` can
 * act on it. Without this a build written by an older Lorepack passes every other check, is
 * reported as "No changes", and then fails at the first request with the guard's message
 * telling the user to run the command that just declined to help (#251, #235).
 *
 * Against the migration files this binary ships, so a future migration is covered by having
 * been added rather than by anyone remembering a number.
 */
function buildSchemaMatches(loreDirectory: string, buildId: BuildId): boolean {
  const path = join(loreDirectory, 'builds', buildId, 'context.sqlite');
  const expected = loadMigrations(buildMigrationsDirectory()).reduce(
    (highest, one) => (one.id > highest ? one.id : highest),
    '0000',
  );
  const db = openReadOnly(path);
  try {
    const row = db.prepare('SELECT max(id) AS latest FROM schema_migrations').get() as
      | { latest: string | null }
      | undefined;
    return (row?.latest ?? '0000') === expected;
  } finally {
    db.close();
  }
}

function readBuildCatalogOrThrow(loreDirectory: string, buildId: BuildId): PreviousBuild | null {
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
