import { SCHEMA_VERSION } from '@lorepack/core';
import { PARSERS } from '@lorepack/parsers';

/**
 * Versions that affect build output, in one place.
 *
 * The lockfile, the manifest and the build id all read from here, so they cannot disagree
 * about which compiler or parser produced a build.
 */
export const COMPILER_VERSION = '0.1.0' as const;

/**
 * Re-exported, not declared. It lives in core because the storage backend has to check a
 * build's schema before reading it, and `backend-local` may not import the CLI.
 */
export { SCHEMA_VERSION };

/**
 * Every registered parser and its version, derived rather than listed.
 *
 * This was a hand-written literal naming markdown and text until #234, which is how the five
 * parsers Phase 5 added came to be absent from the build id entirely. Bumping the XLSX
 * parser's version and rebuilding a project full of spreadsheets produced a byte-identical
 * build id, so a parser fix could not invalidate the artifacts it changed, and `lore diff`
 * saw no difference between two builds whose content differed. Deriving from `PARSERS` makes
 * registering a parser and recording its version one act instead of two.
 *
 * **Every registered parser, not only the ones a project happened to use.** The alternative
 * is tempting, because it means adding a parser to Lorepack cannot disturb the id of a
 * project containing no files of that type. It is rejected for two reasons. The lockfile is
 * written during planning, before anything is parsed, so the contributing set is not known at
 * the point this is needed. And the stability it buys is imaginary: `compilerVersion` is
 * already a build id input, and a release that adds a parser bumps it, so every id moves
 * regardless.
 */
export function parserVersions(): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const parser of PARSERS) versions[parser.id] = parser.version;
  return versions;
}

export function lockInputs(): {
  compilerVersion: string;
  schemaVersion: number;
  parserVersions: Record<string, string>;
} {
  return {
    compilerVersion: COMPILER_VERSION,
    schemaVersion: SCHEMA_VERSION,
    parserVersions: parserVersions(),
  };
}
