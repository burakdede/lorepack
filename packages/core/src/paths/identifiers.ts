import { normalizeUnicode, toPosix } from './canonical.js';

/**
 * Identifiers are derived from a normalized source ID plus the canonical POSIX relative
 * path. No absolute prefix, no drive letter, no native separator: the same logical file
 * checked out on Windows and Linux produces the same identifier.
 */

const UNSAFE_SOURCE_ID = /[^a-z0-9._-]+/g;

export function normalizeSourceId(raw: string): string {
  const cleaned = normalizeUnicode(raw)
    .trim()
    .toLowerCase()
    .replace(UNSAFE_SOURCE_ID, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'source' : cleaned;
}

export function artifactId(sourceId: string, canonicalPath: string): string {
  return `${normalizeSourceId(sourceId)}:${normalizeUnicode(toPosix(canonicalPath))}`;
}

export function nodeId(artifact: string, ordinalPath: readonly number[]): string {
  return `${artifact}#${ordinalPath.join('.')}`;
}

export function chunkId(artifact: string, index: number): string {
  return `${artifact}@${index}`;
}

export interface ParsedArtifactId {
  readonly sourceId: string;
  readonly relativePath: string;
}

export function parseArtifactId(id: string): ParsedArtifactId | null {
  const separator = id.indexOf(':');
  if (separator <= 0 || separator === id.length - 1) return null;
  return { sourceId: id.slice(0, separator), relativePath: id.slice(separator + 1) };
}
