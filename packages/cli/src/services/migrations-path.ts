import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoreError } from '@lorepack/core';

/**
 * Locates the SQL migrations that ship with the CLI.
 *
 * Found by walking up from this module rather than by a fixed number of `..` segments, so
 * the same code works from `src/` under vitest, from `dist/` in the built CLI, and from an
 * installed package where the migrations sit beside the compiled output. `fileURLToPath`
 * rather than `URL.pathname`: the latter yields `/C:/...` on Windows, which no filesystem
 * call accepts.
 */
function locate(kind: 'state' | 'build'): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  const root = parse(directory).root;

  for (;;) {
    const candidate = join(directory, 'migrations', kind);
    if (existsSync(candidate)) return candidate;
    if (directory === root) break;
    directory = dirname(directory);
  }

  throw new LoreError('LORE_E_INTERNAL', 'The bundled SQL migrations could not be found.', {
    remediation: 'Reinstall Lorepack. This is a packaging fault, not a project problem.',
  });
}

/**
 * The two sets are separate on purpose. State migrations create the mutable project
 * database; build migrations create the catalog inside a sealed build. Running both into
 * one database would put empty `builds` and `active_build` tables inside every build,
 * which is exactly the confusion between operational state and canonical content that
 * invariant 1 exists to prevent.
 */
export const STATE_MIGRATIONS: string = locate('state');
export const BUILD_MIGRATIONS: string = locate('build');
