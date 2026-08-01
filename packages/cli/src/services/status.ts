import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openReadOnly } from '@lorepack/backend-local';
import { compareFingerprints, discover, fingerprintSources } from '@lorepack/compiler';
import {
  count,
  LORE_DIRECTORY,
  type LoadedConfig,
  LoreError,
  type ProgressBus,
  type SourceState,
  type Status,
} from '@lorepack/core';
import { readActiveBuild, readBuildCatalog } from './project.js';

/**
 * `lore status` answers one question: is the context my AI reads current?
 *
 * It never writes, not even a migration or a cache entry. Status is run constantly, often
 * in a prompt, and a command that mutated a project as a side effect of being asked about
 * it would be a trap.
 */
export interface StatusOptions {
  readonly config: LoadedConfig;
  readonly progress?: ProgressBus;
  readonly allowLargeProject?: boolean;
  readonly now?: () => Date;
}

export async function readStatus(options: StatusOptions): Promise<Status> {
  const { config } = options;
  const now = options.now ?? (() => new Date());
  const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);

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

  const active = readActiveBuild(loreDirectory);
  const previous = active === null ? null : readBuildCatalog(loreDirectory, active.buildId);

  if (active === null || previous === null) {
    return {
      formatVersion: 1,
      projectName: config.config.name,
      activeBuildId: null,
      activeBuildAt: null,
      buildAgeSeconds: null,
      sourceState: 'unbuilt',
      decidedBy: 'content-hash',
      artifacts: { total: fingerprint.artifacts.length, added: 0, changed: 0, removed: 0 },
      changes: [],
      warnings: discovery.warnings.length,
      remediation: 'lore build',
    };
  }

  const dirty = compareFingerprints(fingerprint.artifacts, previous.artifactHashes);
  const pathOf = pathResolver(fingerprint.artifacts);
  const createdAt = readBuildCreatedAt(loreDirectory, active.buildId);

  return {
    formatVersion: 1,
    projectName: config.config.name,
    activeBuildId: active.buildId,
    activeBuildAt: createdAt,
    buildAgeSeconds:
      createdAt === null
        ? null
        : Math.max(0, Math.floor((now().getTime() - Date.parse(createdAt)) / 1000)),
    sourceState: dirty.clean ? 'clean' : 'dirty',
    decidedBy: 'content-hash',
    artifacts: {
      total: fingerprint.artifacts.length,
      added: dirty.added.length,
      changed: dirty.changed.length,
      removed: dirty.removed.length,
    },
    changes: [
      ...dirty.added.map((id) => ({ path: pathOf(id), change: 'added' as const })),
      ...dirty.changed.map((id) => ({ path: pathOf(id), change: 'changed' as const })),
      ...dirty.removed.map((id) => ({ path: pathOf(id), change: 'removed' as const })),
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    warnings: countBuildWarnings(loreDirectory, active.buildId) ?? discovery.warnings.length,
    remediation: dirty.clean ? null : 'lore build',
  };
}

export interface Freshness {
  readonly sourceState: SourceState;
  /** Why freshness could not be established, for the human rendering. Null when it was. */
  readonly reason: string | null;
}

/**
 * Freshness for a read-only command: an annotation on the answer, never a precondition
 * for it.
 *
 * Section 4.10 says freshness travels with the result, and it is tempting to read that as
 * "establish it or fail". That reading cost `lore search` its usefulness on any project
 * above the file envelope: the build existed and was perfectly queryable, and the query was
 * refused because a guard about the cost of *building* had been consulted first (#147). A
 * read of a sealed build is not entitled to have an opinion about the source tree.
 *
 * So two things differ from `readStatus`:
 *
 * - **The envelope does not apply.** It bounds what Lorepack promises about build
 *   performance, not what it will answer from a build it already made.
 * - **Nothing here can fail the command.** A source tree that is enormous, unreadable or
 *   gone leaves freshness `unknown`, which is precisely what the contract's third state
 *   means, and the caller still gets the build's answer.
 *
 * Invariant 6 applies to the degraded case too: `unknown` says Lorepack does not know, and
 * never that the sources are clean.
 */
export async function readFreshness(options: StatusOptions): Promise<Freshness> {
  try {
    const status = await readStatus({ ...options, allowLargeProject: true });
    return {
      sourceState: status.sourceState === 'unbuilt' ? 'unknown' : status.sourceState,
      reason: null,
    };
  } catch (error) {
    const degraded = degradedFreshness(error);
    if (degraded === null) throw error;
    return degraded;
  }
}

/**
 * Which failures are allowed to become `unknown`, and which must still be raised.
 *
 * An allowlist rather than a bare `catch`. Swallowing everything would turn a corrupt
 * state database into the cheerful and false statement "freshness unknown", which is the
 * kind of helpfulness that hides a real defect for a phase or two. These three all mean
 * "something about the source tree stopped us looking", and none of them says anything
 * about whether the build being read is sound.
 */
export function degradedFreshness(error: unknown): Freshness | null {
  if (!(error instanceof LoreError)) return null;
  const degradable = new Set([
    'LORE_E_ENVELOPE_EXCEEDED',
    'LORE_E_PATH_ESCAPE',
    'LORE_E_CASE_COLLISION',
  ]);
  if (!degradable.has(error.code)) return null;
  return { sourceState: 'unknown', reason: error.message };
}

function pathResolver(
  artifacts: readonly { artifactId: string; relativePath: string }[],
): (artifactId: string) => string {
  const byId = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact.relativePath]));
  // A removed artifact is no longer on disk, so its path comes from the id, which carries
  // the source name and the relative path by construction.
  return (artifactId) => byId.get(artifactId) ?? artifactId.split(':').slice(1).join(':');
}

function readBuildCreatedAt(loreDirectory: string, buildId: string): string | null {
  const statePath = join(loreDirectory, 'state.sqlite');
  if (!existsSync(statePath)) return null;
  const db = openReadOnly(statePath);
  try {
    const row = db.prepare('SELECT created_at FROM builds WHERE build_id = ?').get(buildId) as
      | { created_at: string }
      | undefined;
    return row?.created_at ?? null;
  } finally {
    db.close();
  }
}

/** Warnings as the active build recorded them, which is what the AI is actually reading. */
function countBuildWarnings(loreDirectory: string, buildId: string): number | null {
  const path = join(loreDirectory, 'builds', buildId, 'context.sqlite');
  if (!existsSync(path)) return null;
  const db = openReadOnly(path);
  try {
    const row = db.prepare('SELECT count(*) AS n FROM build_warnings').get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

export function renderStatus(status: Status, verbose: boolean): string {
  const lines: string[] = [`Project ${status.projectName}`];

  if (status.activeBuildId === null) {
    lines.push('');
    lines.push('No build yet.');
    lines.push(`  ${count(status.artifacts.total, 'source file')} found`);
    lines.push('');
    lines.push('Run `lore build` to compile and activate the first build.');
    return lines.join('\n');
  }

  lines.push(
    `Active build ${status.activeBuildId.slice(0, 17)} (${formatAge(status.buildAgeSeconds)})`,
  );
  lines.push('');
  lines.push(
    status.sourceState === 'clean'
      ? `Sources are clean. ${count(status.artifacts.total, 'artifact')}, decided by content hash.`
      : `Sources are dirty: ${status.artifacts.added} added, ${status.artifacts.changed} changed, ${status.artifacts.removed} removed.`,
  );

  if (verbose && status.changes.length > 0) {
    lines.push('');
    for (const kind of ['added', 'changed', 'removed'] as const) {
      const paths = status.changes.filter((change) => change.change === kind);
      if (paths.length === 0) continue;
      lines.push(`${kind}:`);
      for (const change of paths) lines.push(`  ${change.path}`);
    }
  }

  if (status.warnings > 0) {
    lines.push(`${count(status.warnings, 'warning')} in the active build.`);
  }

  if (status.remediation !== null) {
    lines.push('');
    lines.push(`Run \`${status.remediation}\` to make the active context current.`);
  }

  return lines.join('\n');
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'age unknown';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
