import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoreError } from '@lorepack/core';

/**
 * Locates the SQL migrations that ship with this package.
 *
 * They live here, next to the code that runs them, and `files` in package.json publishes
 * them. The bundled CLI copies them under its ignored `dist/` output because its single
 * public entry point owns the package root at runtime. That is the whole fix for #164: they
 * used to sit at the repository root, which no package ships, so every command worked from a
 * checkout and none worked from an install.
 *
 * Resolution is anchored to the package root, one level above this module in the normal
 * package layout, with one explicit bundled-CLI output path. It never walks upward until
 * something matches. A walk found the repository's copy from anywhere inside the tree, which
 * is exactly why the missing asset was invisible to every test. Anchoring means a packaging
 * mistake fails here, in this package, instead of climbing to the filesystem root and blaming
 * the user's project.
 *
 * `fileURLToPath` rather than `URL.pathname`: the latter yields `/C:/...` on Windows, which
 * no filesystem call accepts.
 */

/** The two sets, resolved lazily so a failure reaches the CLI's error renderer. */
export type MigrationSet = 'state' | 'build';

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * The sets are separate on purpose. State migrations create the mutable project database;
 * build migrations create the catalog inside a sealed build. Running both into one database
 * would put empty `builds` and `active_build` tables inside every build, which is exactly
 * the confusion between operational state and canonical content that invariant 1 exists to
 * prevent.
 */
export function migrationsDirectory(set: MigrationSet): string {
  const primaryCandidate = join(packageRoot(), 'migrations', set);
  const candidates = [primaryCandidate, join(packageRoot(), 'dist', 'migrations', set)];
  const candidate = candidates.find((path) => existsSync(path));
  if (candidate !== undefined) return candidate;

  throw new LoreError(
    'LORE_E_INTERNAL',
    `The bundled ${set} SQL migrations are missing from @lorepack/backend-local.`,
    {
      remediation: 'Reinstall Lorepack. This is a packaging fault, not a project problem.',
      subject: primaryCandidate,
    },
  );
}

export function stateMigrationsDirectory(): string {
  return migrationsDirectory('state');
}

export function buildMigrationsDirectory(): string {
  return migrationsDirectory('build');
}
