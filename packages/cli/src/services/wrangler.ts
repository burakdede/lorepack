import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LoreError } from '@lorepack/core';

/**
 * Finding the Wrangler a deploy runs.
 *
 * Wrangler is never a dependency of the published CLI: it pulls native tooling, and invariant 7
 * promises an install without any. So the user brings it, either in the project
 * (`npm install --save-dev wrangler`) or installed next to lorepack, and this finds it.
 *
 * Resolution goes through Node's own algorithm for the package **named** `wrangler`, starting
 * from each directory in turn. The first version instead walked three directories up from its
 * own file (#580). From the bundled CLI that left the package, so Wrangler was never found, and
 * from an npm install it pointed at `node_modules/deploy-cloudflare/node_modules/wrangler`, an
 * unscoped name anyone could publish and have `lorepack deploy` execute.
 */

export interface WranglerLocation {
  /** The JavaScript entry point, run with this process's own Node. */
  readonly bin: string;
  readonly version: string;
}

/** Where to look, most specific first: the project's own dependency, then the CLI's install. */
export function wranglerSearchDirectories(projectRoot: string): readonly string[] {
  return [projectRoot, import.meta.dirname];
}

export function locateWrangler(directories: readonly string[]): WranglerLocation | null {
  for (const directory of directories) {
    const located = resolveFrom(directory);
    if (located !== null) return located;
  }
  return null;
}

function resolveFrom(directory: string): WranglerLocation | null {
  let manifestPath: string;
  try {
    const resolved = findPackageJSON(
      'wrangler/package.json',
      pathToFileURL(join(directory, 'noop.js')),
    );
    if (resolved === undefined) return null;
    manifestPath = realpathSync(resolved);
  } catch {
    return null;
  }

  let manifest: { name?: unknown; version?: unknown; bin?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
  } catch {
    return null;
  }
  if (manifest.name !== 'wrangler') return null;

  const relative =
    typeof manifest.bin === 'string'
      ? manifest.bin
      : typeof manifest.bin === 'object' && manifest.bin !== null
        ? (manifest.bin as Record<string, unknown>).wrangler
        : undefined;
  if (typeof relative !== 'string') return null;

  const bin = join(dirname(manifestPath), relative);
  if (!existsSync(bin)) return null;
  return { bin, version: typeof manifest.version === 'string' ? manifest.version : 'unknown' };
}

let workingDirectory: string | null = null;

/**
 * An empty directory to run Wrangler in.
 *
 * Wrangler reads `wrangler.toml` or `wrangler.jsonc` from its working directory, and a project
 * may hold one for an unrelated Worker, with its own account id. The commands Lorepack runs name
 * every resource explicitly, so they should see no ambient configuration at all.
 */
export function wranglerWorkingDirectory(): string {
  workingDirectory ??= mkdtempSync(join(tmpdir(), 'lore-wrangler-'));
  return workingDirectory;
}

export const WRANGLER_MISSING_REMEDIATION =
  'Install Wrangler in this project with `npm install --save-dev wrangler`, or install it next to lorepack (`npm install --global wrangler` for a global lorepack).';

/** The entry point to run, or the error a user can act on when there is none. */
export function requireWranglerBin(location: WranglerLocation | null): string {
  if (location !== null) return location.bin;
  throw new LoreError('LORE_E_TARGET_NOT_CONFIGURED', 'Wrangler was not found for this project.', {
    remediation: WRANGLER_MISSING_REMEDIATION,
    subject: 'cloudflare',
  });
}
