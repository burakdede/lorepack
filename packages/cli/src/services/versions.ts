import { markdownParser, textParser } from '@lorepack/parsers';

/**
 * Versions that affect build output, in one place.
 *
 * The lockfile, the manifest and the build id all read from here, so they cannot disagree
 * about which compiler or parser produced a build.
 */
export const COMPILER_VERSION = '0.1.0' as const;
export const SCHEMA_VERSION = 1 as const;

export function lockInputs(): {
  compilerVersion: string;
  schemaVersion: number;
  parserVersions: Record<string, string>;
} {
  return {
    compilerVersion: COMPILER_VERSION,
    schemaVersion: SCHEMA_VERSION,
    parserVersions: {
      [markdownParser.id]: markdownParser.version,
      [textParser.id]: textParser.version,
    },
  };
}
