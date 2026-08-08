import { type Canonical, hashCanonical } from './canonical.js';
import {
  assertBuildId,
  BUILD_ID_PREFIX,
  type BuildId,
  DEFAULT_DISPLAY_LENGTH,
  formatBuildId,
  isBuildId,
  resolveBuildIdPrefix,
} from './id.js';

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
 * - 3: `chunks.page`, so a citation of a PDF names the page rather than a line it is not on
 *      (#241).
 */

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

export {
  assertBuildId,
  BUILD_ID_PREFIX,
  type BuildId,
  DEFAULT_DISPLAY_LENGTH,
  formatBuildId,
  isBuildId,
  resolveBuildIdPrefix,
};
