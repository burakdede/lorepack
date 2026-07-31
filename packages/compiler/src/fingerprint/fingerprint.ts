import { availableParallelism } from 'node:os';
import {
  type Canonical,
  hashCanonical,
  hashFile,
  type ProgressBus,
  sha256Hex,
} from '@lorepack/core';
import type { DiscoveredArtifact } from '../discover/discover.js';

export interface FingerprintedArtifact extends DiscoveredArtifact {
  readonly contentHash: string;
}

export interface SourceFingerprint {
  /** One hash over every artifact identity and content hash. */
  readonly fingerprint: string;
  readonly artifacts: readonly FingerprintedArtifact[];
  readonly totalBytes: number;
  readonly durationMs: number;
}

export interface FingerprintOptions {
  readonly artifacts: readonly DiscoveredArtifact[];
  readonly progress?: ProgressBus;
  readonly concurrency?: number;
  readonly now?: () => number;
}

/**
 * Content hashes, not file metadata, decide whether a project is clean.
 *
 * Architecture section 12.3 is explicit: size and modification time are kept for
 * diagnostics and for coalescing watch events, but they are never proof of freshness. A
 * file can change without its mtime moving, and an mtime can move without the content
 * changing; only the bytes settle it.
 */
export async function fingerprintSources(options: FingerprintOptions): Promise<SourceFingerprint> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const { artifacts, progress } = options;

  progress?.start('fingerprinting', 'Fingerprinting', artifacts.length);

  const concurrency = Math.max(1, options.concurrency ?? Math.min(8, availableParallelism()));
  const hashed = new Array<FingerprintedArtifact>(artifacts.length);
  let next = 0;
  let done = 0;

  // Bounded concurrency with the order restored afterwards: hashing is IO bound, so some
  // parallelism helps, but the result must not depend on which worker finished first.
  const workers = Array.from({ length: Math.min(concurrency, artifacts.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= artifacts.length) return;
      const artifact = artifacts[index] as DiscoveredArtifact;
      hashed[index] = { ...artifact, contentHash: await hashFile(artifact.absolutePath) };
      done += 1;
      if (done % 25 === 0 || done === artifacts.length) {
        progress?.progress('fingerprinting', done, { total: artifacts.length, unit: 'files' });
      }
    }
  });
  await Promise.all(workers);

  const totalBytes = hashed.reduce((sum, artifact) => sum + artifact.byteSize, 0);
  progress?.finish('fingerprinting', hashed.length);

  return {
    fingerprint: computeFingerprint(hashed),
    artifacts: hashed,
    totalBytes,
    durationMs: Math.round(now() - startedAt),
  };
}

/** One value summarising every artifact identity and its content. */
export function computeFingerprint(artifacts: readonly FingerprintedArtifact[]): string {
  const members: Canonical = [...artifacts]
    .map((artifact) => [artifact.artifactId, artifact.contentHash] as Canonical)
    .sort((a, b) => {
      const left = (a as string[])[0] ?? '';
      const right = (b as string[])[0] ?? '';
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return hashCanonical(members);
}

export interface DirtyState {
  readonly clean: boolean;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

/** Compares a fresh fingerprint against what a build recorded. */
export function compareFingerprints(
  current: readonly FingerprintedArtifact[],
  previous: ReadonlyMap<string, string>,
): DirtyState {
  const added: string[] = [];
  const changed: string[] = [];
  const seen = new Set<string>();

  for (const artifact of current) {
    seen.add(artifact.artifactId);
    const before = previous.get(artifact.artifactId);
    if (before === undefined) added.push(artifact.artifactId);
    else if (before !== artifact.contentHash) changed.push(artifact.artifactId);
  }

  const removed = [...previous.keys()].filter((id) => !seen.has(id)).sort();
  return {
    clean: added.length === 0 && changed.length === 0 && removed.length === 0,
    added: added.sort(),
    changed: changed.sort(),
    removed,
  };
}

/**
 * Cache key for parsed output.
 *
 * Architecture section 12.3 lists exactly what it covers: content, parser identity, the
 * configuration that affects output, and the rule inputs. Under-including means reusing a
 * stale parse; over-including means rebuilding for no reason. Both are wrong, so the
 * inputs are named explicitly rather than derived from a whole config object.
 */
export interface CacheKeyInputs {
  /**
   * The artifact's identity, which carries its normalized path. Section 18.2 makes the
   * path part of the reuse condition, and it has to be: two files with identical content
   * at different paths are different artifacts, and a key that ignored the path would
   * hand one of them the other's record.
   */
  readonly artifactId: string;
  readonly contentHash: string;
  readonly parserId: string;
  readonly parserVersion: string;
  readonly normalizationVersion: number;
  readonly chunking: Canonical;
  readonly rules: Canonical;
}

export function cacheKey(inputs: CacheKeyInputs): string {
  return sha256Hex(
    hashCanonical({
      artifactId: inputs.artifactId,
      contentHash: inputs.contentHash,
      parserId: inputs.parserId,
      parserVersion: inputs.parserVersion,
      normalizationVersion: inputs.normalizationVersion,
      chunking: inputs.chunking,
      rules: inputs.rules,
    }),
  );
}
