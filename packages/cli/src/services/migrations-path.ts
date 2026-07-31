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
function locate(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  const root = parse(directory).root;

  for (;;) {
    const candidate = join(directory, 'migrations', 'local');
    if (existsSync(candidate)) return candidate;
    if (directory === root) break;
    directory = dirname(directory);
  }

  throw new LoreError('LORE_E_INTERNAL', 'The bundled SQL migrations could not be found.', {
    remediation: 'Reinstall Lorepack. This is a packaging fault, not a project problem.',
  });
}

export const MIGRATIONS_DIRECTORY: string = locate();
