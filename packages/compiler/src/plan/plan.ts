import {
  type BuildId,
  count,
  type LoadedConfig,
  type Lockfile,
  type Plan,
  type ProgressBus,
} from '@lorepack/core';
import { type DiscoveryResult, discover } from '../discover/discover.js';
import {
  compareFingerprints,
  fingerprintSources,
  type SourceFingerprint,
} from '../fingerprint/fingerprint.js';
import { buildLockfile, compareLockfiles, type LockfileInputs } from '../lock/lockfile.js';

/**
 * `lore plan` is the Terraform half of the product: a side-effect-free preview of every
 * intended mutation.
 *
 * It is one pure function over (config, lock, fingerprints, active build), so the CLI,
 * Studio and `lore deploy` all show the same thing. Anything that writes belongs to the
 * build orchestrator; a plan that touched the filesystem would not be a plan.
 */

export interface PreviousBuild {
  readonly buildId: BuildId;
  /** Artifact id to content hash, as recorded by the active build. */
  readonly artifactHashes: ReadonlyMap<string, string>;
  readonly chunkCount: number;
  readonly capabilities: readonly string[];
}

export interface PlanOptions {
  readonly config: LoadedConfig;
  readonly previous: PreviousBuild | null;
  readonly previousLock: Lockfile | null;
  readonly lockInputs: LockfileInputs;
  readonly progress?: ProgressBus;
  readonly allowLargeProject?: boolean;
  readonly now?: () => Date;
}

export interface PlanResult {
  readonly plan: Plan;
  readonly discovery: DiscoveryResult;
  readonly fingerprint: SourceFingerprint;
}

export async function createPlan(options: PlanOptions): Promise<PlanResult> {
  const { config, previous } = options;
  const now = options.now ?? (() => new Date());

  const discovery = discover({
    config,
    ...(options.progress === undefined ? {} : { progress: options.progress }),
    ...(options.allowLargeProject === undefined
      ? {}
      : { allowLargeProject: options.allowLargeProject }),
  });
  const fingerprint = await fingerprintSources({
    artifacts: discovery.artifacts,
    ...(options.progress === undefined ? {} : { progress: options.progress }),
  });

  const dirty = compareFingerprints(
    fingerprint.artifacts,
    previous?.artifactHashes ?? new Map<string, string>(),
  );
  const reused = fingerprint.artifacts.length - dirty.added.length - dirty.changed.length;

  const lock = compareLockfiles(options.previousLock, buildLockfile(options.lockInputs));

  // A parser or schema change invalidates every cached parse, so expected work is the
  // whole corpus rather than only what the user edited. Saying otherwise would promise a
  // fast rebuild and then take minutes.
  const lockInvalidatesEverything =
    lock.changed && lock.changes.some((change) => change.key !== 'lore.lock');
  const parseCount = lockInvalidatesEverything
    ? fingerprint.artifacts.length
    : dirty.added.length + dirty.changed.length;

  const byId = new Map(fingerprint.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const pathOf = (artifactId: string): string =>
    byId.get(artifactId)?.relativePath ?? artifactId.split(':').slice(1).join(':');

  const plan: Plan = {
    formatVersion: 1,
    projectName: config.config.name,
    activeBuildId: previous?.buildId ?? null,
    generatedAt: now().toISOString(),
    sourceState: previous === null ? 'unknown' : dirty.clean ? 'clean' : 'dirty',
    artifacts: {
      added: dirty.added.length,
      changed: dirty.changed.length,
      removed: dirty.removed.length,
      reused: Math.max(0, reused),
      changes: [
        ...dirty.added.map((id) => ({ path: pathOf(id), change: 'added' as const })),
        ...dirty.changed.map((id) => ({ path: pathOf(id), change: 'changed' as const })),
        ...dirty.removed.map((id) => ({ path: pathOf(id), change: 'removed' as const })),
      ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    },
    // Rules and tables arrive in Phase 5; the shape is fixed now so the plan schema does
    // not change when they do.
    rules: [],
    tables: [],
    lock: { changed: lock.changed, changes: [...lock.changes] },
    capabilities: {
      current: (previous?.capabilities ?? []) as Plan['capabilities']['current'],
      next: ['lexical-search', 'structured-context'],
    },
    expectedWork: {
      parseArtifacts: parseCount,
      reuseArtifacts: Math.max(0, fingerprint.artifacts.length - parseCount),
      rebuildChunks: parseCount === 0 ? 0 : estimateChunkWork(parseCount, previous),
    },
    // Both stages that can exclude a file, so the plan names every file the build will
    // leave out before the build runs, rather than only the ones decided by extension.
    warnings: [...discovery.warnings, ...fingerprint.warnings].map((warning) => ({
      code: warning.code,
      message: warning.message,
    })),
  };

  return { plan, discovery, fingerprint };
}

/**
 * An estimate, and labelled as one in the rendering. The exact count is only known after
 * parsing, and a plan that parsed to report accurately would not be side-effect free.
 */
function estimateChunkWork(parseCount: number, previous: PreviousBuild | null): number {
  if (previous === null || previous.chunkCount === 0) return parseCount * 3;
  const perArtifact = Math.max(1, Math.round(previous.chunkCount / Math.max(1, parseCount)));
  return Math.min(previous.chunkCount, parseCount * perArtifact);
}

/** The human rendering from architecture section 6.10. */
export function renderPlan(plan: Plan): string {
  const lines: string[] = [];
  const target =
    plan.activeBuildId === null ? 'first build' : `${plan.activeBuildId.slice(0, 17)} -> candidate`;
  lines.push(`Plan for ${target}`, '');

  lines.push('Artifacts');
  lines.push(`  + ${plan.artifacts.added} added`);
  lines.push(`  ~ ${plan.artifacts.changed} changed`);
  lines.push(`  - ${plan.artifacts.removed} removed`);
  lines.push(`  = ${plan.artifacts.reused} reused`);

  if (plan.artifacts.changes.length > 0 && plan.artifacts.changes.length <= 20) {
    lines.push('');
    for (const change of plan.artifacts.changes) {
      const marker = change.change === 'added' ? '+' : change.change === 'changed' ? '~' : '-';
      lines.push(`  ${marker} ${change.path}`);
    }
  }

  if (plan.lock.changed) {
    lines.push('', 'Lock');
    for (const change of plan.lock.changes) {
      lines.push(`  ~ ${change.key} ${change.from ?? 'absent'} -> ${change.to ?? 'absent'}`);
    }
  }

  // Phrased as one total split two ways, because the build's parsing stage visits every
  // artifact and reports `3/3`. Saying "parse 1" here and showing "3/3" there described the
  // same work with two different numbers, and left the reader to guess which was true.
  const visited = plan.expectedWork.parseArtifacts + plan.expectedWork.reuseArtifacts;
  lines.push('', 'Expected work');
  lines.push(
    `  ${count(visited, 'artifact')} to process: ${plan.expectedWork.parseArtifacts} parsed, ${plan.expectedWork.reuseArtifacts} reused from cache`,
  );
  lines.push(`  about ${count(plan.expectedWork.rebuildChunks, 'chunk')} rebuilt`);

  if (plan.warnings.length > 0) {
    lines.push('', `Warnings (${plan.warnings.length})`);
    for (const warning of plan.warnings.slice(0, 10)) lines.push(`  ${warning.message}`);
    if (plan.warnings.length > 10) lines.push(`  and ${plan.warnings.length - 10} more`);
  }

  return lines.join('\n');
}
