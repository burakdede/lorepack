import { LoreError } from '../errors/lore-error.js';
import { type Canonical, hashCanonical } from './canonical.js';

export type BuildId = `lore_${string}`;

export const BUILD_ID_PREFIX = 'lore_' as const;
export const DEFAULT_DISPLAY_LENGTH = 12 as const;

/**
 * The shape of the catalog inside a sealed build.
 *
 * Bumped whenever a build migration changes what a reader will find, because a sealed build is
 * never migrated in place: migrations run only against a writable database, and a build is
 * opened read-only. So a build carries the schema it was written at, forever, and a reader
 * that assumed otherwise would fail deep inside SQLite rather than at the boundary.
 *
 * It lives here rather than beside the compiler because it is a build id input, and because
 * the storage backend has to check it. Both would otherwise reach across a package boundary
 * for a number.
 *
 * - 1: the original catalog (#15, #76).
 * - 2: `tables.cell_range`, so a table's locator carries the range the parser recorded (#235).
 */
export const SCHEMA_VERSION = 2 as const;

/**
 * Everything that legitimately changes build output, and nothing else. Architecture
 * section 11.4 fixes this list; adding a field here changes every build ID, so it is a
 * reviewed, format-affecting act.
 *
 * Deliberately excluded: timestamps, hostname, absolute workspace path, temporary
 * directory, deployment target, ZIP metadata, and the physical byte layout of
 * context.sqlite. Two machines with different paths must agree.
 */
export interface BuildIdInputs {
  readonly formatVersion: number;
  readonly schemaVersion: number;
  readonly compilerVersion: string;
  readonly canonicalizationVersion: number;
  readonly normalizationVersion: number;
  /** Effective configuration with secrets and absolute paths already removed. */
  readonly effectiveConfig: Canonical;
  /** Parser identifier to version, for every parser that contributed. */
  readonly parserVersions: Readonly<Record<string, string>>;
  /** Resolved rules per artifact, already sorted by the caller's canonical rules. */
  readonly ruleResolution: Canonical;
  readonly embeddingProfile: Canonical | null;
  readonly canonicalRoots: {
    readonly artifacts: string;
    readonly nodes: string;
    readonly chunks: string;
    readonly tables: string;
    readonly objects: string;
  };
}

export const BUILD_ID_INPUT_FIELDS: readonly (keyof BuildIdInputs)[] = [
  'formatVersion',
  'schemaVersion',
  'compilerVersion',
  'canonicalizationVersion',
  'normalizationVersion',
  'effectiveConfig',
  'parserVersions',
  'ruleResolution',
  'embeddingProfile',
  'canonicalRoots',
];

export function deriveBuildId(inputs: BuildIdInputs): BuildId {
  const canonical: Canonical = {
    formatVersion: inputs.formatVersion,
    schemaVersion: inputs.schemaVersion,
    compilerVersion: inputs.compilerVersion,
    canonicalizationVersion: inputs.canonicalizationVersion,
    normalizationVersion: inputs.normalizationVersion,
    effectiveConfig: inputs.effectiveConfig,
    parserVersions: { ...inputs.parserVersions },
    ruleResolution: inputs.ruleResolution,
    embeddingProfile: inputs.embeddingProfile,
    canonicalRoots: { ...inputs.canonicalRoots },
  };
  return `${BUILD_ID_PREFIX}${hashCanonical(canonical)}`;
}

const BUILD_ID_PATTERN = /^lore_[0-9a-f]{64}$/;

export function isBuildId(value: string): value is BuildId {
  return BUILD_ID_PATTERN.test(value);
}

export function assertBuildId(value: string): BuildId {
  if (!isBuildId(value)) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `Not a valid build identifier: ${value}`, {
      remediation: 'Use a full build id, or a unique prefix of one. Run `lore inspect builds`.',
      subject: value,
    });
  }
  return value;
}

/**
 * Shortest unambiguous prefix for display, never below 12 characters. Manifests, APIs and
 * directories always store the full digest; only humans see the short form.
 */
export function formatBuildId(
  id: BuildId,
  known: readonly BuildId[] = [],
  minimum: number = DEFAULT_DISPLAY_LENGTH,
): string {
  const digest = id.slice(BUILD_ID_PREFIX.length);
  const others = known
    .filter((candidate) => candidate !== id)
    .map((c) => c.slice(BUILD_ID_PREFIX.length));
  let length = Math.max(minimum, 1);
  while (length < digest.length) {
    const prefix = digest.slice(0, length);
    if (!others.some((other) => other.startsWith(prefix))) break;
    length += 1;
  }
  return `${BUILD_ID_PREFIX}${digest.slice(0, length)}`;
}

/** Resolves a user-supplied prefix against known builds. */
export function resolveBuildIdPrefix(prefix: string, known: readonly BuildId[]): BuildId {
  const normalized = prefix.startsWith(BUILD_ID_PREFIX)
    ? prefix.slice(BUILD_ID_PREFIX.length)
    : prefix;
  const matches = known.filter((id) => id.slice(BUILD_ID_PREFIX.length).startsWith(normalized));
  if (matches.length === 1) return matches[0] as BuildId;
  if (matches.length === 0) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No build matches ${prefix}.`, {
      remediation: 'Run `lore inspect builds` to list available builds.',
      subject: prefix,
    });
  }
  throw new LoreError('LORE_E_BUILD_NOT_FOUND', `${prefix} is ambiguous.`, {
    remediation: `Use more characters. Candidates: ${matches.map((m) => formatBuildId(m, matches)).join(', ')}`,
    subject: prefix,
    details: { candidates: matches },
  });
}
