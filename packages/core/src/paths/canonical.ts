import { isAbsolute, relative, resolve, sep } from 'node:path';
import { LoreError } from '../errors/lore-error.js';

/**
 * Canonical form is POSIX-separated, relative to the configured source root, and
 * NFC-normalized. Only this form enters identifiers and hashes, so a build ID cannot
 * depend on the operating system or on where the project happens to live.
 *
 * The normalization policy is versioned because it feeds build identity: changing it
 * changes every artifact ID, which must be a deliberate, reviewed act.
 */
export const NORMALIZATION_VERSION = 1 as const;
export const UNICODE_NORMALIZATION_FORM = 'NFC' as const;

const WINDOWS_DEVICE_PATH = /^\\\\[.?]\\/;
const UNC_PATH = /^\\\\[^.?\\]/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;

export function toPosix(path: string): string {
  return path.split(/[\\/]+/).join('/');
}

/** Native rendering for user-facing output. Identifiers never use this. */
export function toDisplay(canonical: string): string {
  return sep === '/' ? canonical : canonical.split('/').join(sep);
}

export function normalizeUnicode(value: string): string {
  return value.normalize(UNICODE_NORMALIZATION_FORM);
}

function rejectExoticPath(input: string): void {
  if (WINDOWS_DEVICE_PATH.test(input)) {
    throw new LoreError('LORE_E_PATH_ESCAPE', `Device paths are not supported: ${input}`, {
      remediation: 'Use an ordinary filesystem path inside the project.',
      path: input,
    });
  }
  if (UNC_PATH.test(input)) {
    throw new LoreError('LORE_E_PATH_ESCAPE', `UNC paths are not supported: ${input}`, {
      remediation: 'Map the share to a drive letter, or copy the sources into the project.',
      path: input,
    });
  }
}

/**
 * Converts an absolute path into its canonical relative form, rejecting anything that
 * escapes the root. Callers that must also defeat symlinks resolve real paths first and
 * pass those in; this function reasons about the strings it is given.
 */
export function toCanonical(root: string, absolutePath: string): string {
  rejectExoticPath(absolutePath);
  rejectExoticPath(root);

  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(absolutePath);
  const rel = relative(resolvedRoot, resolvedPath);

  if (rel === '') {
    throw new LoreError('LORE_E_PATH_ESCAPE', 'A source path cannot be the root itself.', {
      path: toPosix(absolutePath),
    });
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new LoreError(
      'LORE_E_PATH_ESCAPE',
      `${toPosix(absolutePath)} resolves outside the configured source root.`,
      {
        remediation: 'Move the file inside the source root, or add its directory as a source.',
        path: toPosix(absolutePath),
        details: { root: toPosix(resolvedRoot) },
      },
    );
  }
  return normalizeUnicode(toPosix(rel));
}

/** True when the path stays inside the root. Non-throwing companion to toCanonical. */
export function isInsideRoot(root: string, absolutePath: string): boolean {
  try {
    toCanonical(root, absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Byte-order sort over canonical paths. Locale-aware comparison would order differently
 * per machine, which would leak into any hash computed over an ordered list.
 */
export function compareCanonical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortCanonical(paths: readonly string[]): string[] {
  return [...paths].sort(compareCanonical);
}

export interface CaseCollision {
  readonly lowercased: string;
  readonly paths: readonly string[];
}

/**
 * Two paths differing only by case break on case-insensitive filesystems: one silently
 * shadows the other, and which one wins depends on the machine. Detected, never resolved.
 */
export function findCaseCollisions(paths: readonly string[]): CaseCollision[] {
  const byLower = new Map<string, string[]>();
  for (const path of paths) {
    const key = path.toLowerCase();
    const bucket = byLower.get(key);
    if (bucket === undefined) byLower.set(key, [path]);
    else if (!bucket.includes(path)) bucket.push(path);
  }
  const collisions: CaseCollision[] = [];
  for (const [lowercased, group] of byLower) {
    if (group.length > 1) collisions.push({ lowercased, paths: sortCanonical(group) });
  }
  return collisions.sort((a, b) => compareCanonical(a.lowercased, b.lowercased));
}

export function assertNoCaseCollisions(paths: readonly string[]): void {
  const collisions = findCaseCollisions(paths);
  if (collisions.length === 0) return;
  const first = collisions[0] as CaseCollision;
  throw new LoreError(
    'LORE_E_CASE_COLLISION',
    `Source paths differ only by case: ${first.paths.join(' and ')}`,
    {
      remediation:
        'Rename one of the files. On a case-insensitive filesystem one silently shadows the other, and which one wins depends on the machine.',
      details: { collisions },
    },
  );
}

export function hasWindowsDriveLetter(path: string): boolean {
  return WINDOWS_DRIVE.test(path);
}
