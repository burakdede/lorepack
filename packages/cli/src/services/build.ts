import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  countRows,
  createCandidateDirectory,
  discardCandidateDirectory,
  FileObjectStore,
  integrityCheck,
  LocalStateStore,
  loadMigrations,
  openWritable,
  ProjectLock,
  runMigrations,
  sealCandidateDirectory,
  searchCatalog,
  writeCatalog,
} from '@lorepack/backend-local';
import {
  assertNoDrift,
  buildLockfile,
  type Chunk,
  cacheKey,
  chunkArtifact,
  compareLockfiles,
  createPlan,
  normalizeArtifact,
  readLockfile,
  validateCandidate,
  writeLockfile,
} from '@lorepack/compiler';
import {
  type BuildId,
  type BuildManifest,
  buildManifestSchema,
  CANONICALIZATION_VERSION,
  type Canonical,
  deriveBuildId,
  hashCanonical,
  hashRoot,
  LORE_DIRECTORY,
  type LoadedConfig,
  LoreError,
  NORMALIZATION_VERSION,
  type ParsedArtifact,
  type ProgressBus,
  secretsFromEnv,
  writeFileAtomic,
} from '@lorepack/core';
import { parserFor } from '@lorepack/parsers';
import { MIGRATIONS_DIRECTORY } from './migrations-path.js';
import { type CachedParse, ParseCache } from './parse-cache.js';
import { readBuildCatalog } from './project.js';
import { lockInputs } from './versions.js';

/**
 * The build orchestrator.
 *
 * Stage order matters and is the whole point: validate the candidate **in place**, then
 * seal it into `builds/`, then record it, and only then activate as a separate step. A
 * candidate lives under `.lore/tmp/` until it has passed, so an interrupted or failed
 * build cannot leave something in `builds/` that a later run would treat as real.
 */

export interface BuildOptions {
  readonly config: LoadedConfig;
  readonly progress: ProgressBus;
  readonly frozen?: boolean;
  readonly activate?: boolean;
  readonly allowLargeProject?: boolean;
  readonly signal?: AbortSignal;
  /** How long to wait for the project lock. Tests use a short wait; users get the default. */
  readonly lockWaitMs?: number;
  readonly now?: () => Date;
}

export interface BuildResult {
  readonly buildId: BuildId;
  readonly created: boolean;
  readonly activated: boolean;
  readonly counts: BuildManifest['counts'];
  readonly warnings: number;
  readonly reusedArtifacts: number;
  readonly rebuiltArtifacts: number;
  readonly durationMs: number;
}

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
  const { config, progress } = options;
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);

  const lock = new ProjectLock(join(loreDirectory, 'lock'), {
    ...(options.lockWaitMs === undefined ? {} : { waitMs: options.lockWaitMs }),
    onWait: ({ pid }) =>
      progress.diagnostic(
        'info',
        pid === null
          ? 'Waiting for the project lock held by another Lorepack process.'
          : `Waiting for the project lock held by pid ${pid}.`,
      ),
  });
  return lock.withLock(async () => {
    const state = LocalStateStore.open(loreDirectory, MIGRATIONS_DIRECTORY);
    const objects = new FileObjectStore(join(loreDirectory, 'objects'));

    try {
      const previousLock = readLockfile(config.projectRoot);
      const nextLock = buildLockfile(lockInputs());
      if (options.frozen === true) assertNoDrift(compareLockfiles(previousLock, nextLock));

      const active = state.current();
      const previous = active === null ? null : readBuildCatalog(loreDirectory, active.buildId);

      const { discovery, fingerprint } = await createPlan({
        config,
        previous,
        previousLock,
        lockInputs: lockInputs(),
        progress,
        ...(options.allowLargeProject === undefined
          ? {}
          : { allowLargeProject: options.allowLargeProject }),
      });
      throwIfAborted(options.signal);

      const cache = new ParseCache(join(loreDirectory, 'cache', 'parse'));
      progress.start('parsing', 'Parsing', fingerprint.artifacts.length);
      const parsed: CachedParse[] = [];
      let handled = 0;

      for (const discovered of fingerprint.artifacts) {
        throwIfAborted(options.signal);
        const parser = parserFor({
          mediaType: discovered.mediaType,
          relativePath: discovered.relativePath,
        });
        if (parser === null) continue;

        const key = cacheKey({
          artifactId: discovered.artifactId,
          contentHash: discovered.contentHash,
          parserId: parser.id,
          parserVersion: parser.version,
          normalizationVersion: NORMALIZATION_VERSION,
          chunking: config.effective.chunking as unknown as Canonical,
          rules: [],
        });

        // A hit still has to have its normalized body present: the object store and the
        // cache can be pruned independently, and reusing a parse whose body is gone would
        // produce a build that cannot answer a source read.
        const cached = cache.get(key);
        if (cached !== null && (await objects.has(cached.objectHash))) {
          parsed.push(cached);
          handled += 1;
          continue;
        }

        const bytes = new Uint8Array(readFileSync(discovered.absolutePath));
        let result: ParsedArtifact;
        try {
          result = parser.parse({
            artifactId: discovered.artifactId,
            sourceId: discovered.sourceId,
            relativePath: discovered.relativePath,
            displayPath: discovered.displayPath,
            mediaType: discovered.mediaType,
            byteSize: discovered.byteSize,
            contentHash: discovered.contentHash,
            bytes,
          });
        } catch (cause) {
          // A supported, included file that cannot be parsed fails the candidate by
          // default (architecture section 6.9). The previous build stays active.
          throw new LoreError('LORE_E_PARSE_FAILED', `Could not parse ${discovered.displayPath}.`, {
            remediation:
              'Fix the file, or exclude it in .loreignore. The active build is unchanged.',
            path: discovered.displayPath,
            cause,
          });
        }

        const normalized = await normalizeArtifact({ parsed: result, objects });
        const entry: CachedParse = {
          artifact: result.artifact,
          nodes: normalized.nodes,
          chunks: chunkArtifact({
            artifactId: result.artifact.id,
            nodes: normalized.nodes,
            chunking: config.effective.chunking,
          }),
          objectHash: normalized.objectHash,
        };
        cache.put(key, entry);
        parsed.push(entry);

        handled += 1;
        if (handled % 10 === 0) progress.progress('parsing', handled, { unit: 'documents' });
      }
      progress.finish('parsing', handled);

      // Identity, derived before anything is written so the directory is named correctly.
      const buildId = deriveBuildId({
        formatVersion: 1,
        schemaVersion: nextLock.schema,
        compilerVersion: nextLock.compiler,
        canonicalizationVersion: CANONICALIZATION_VERSION,
        normalizationVersion: NORMALIZATION_VERSION,
        effectiveConfig: config.effective as unknown as Canonical,
        parserVersions: nextLock.parsers,
        ruleResolution: [],
        embeddingProfile: null,
        canonicalRoots: canonicalRoots(parsed),
      });

      const existing = state.getBuild(buildId);
      if (existing !== null) {
        const activated = options.activate !== false && state.current()?.buildId !== buildId;
        if (activated) state.activate(buildId);
        return {
          buildId,
          created: false,
          activated,
          counts: countsOf(parsed),
          warnings: discovery.warnings.length,
          reusedArtifacts: cache.hits,
          rebuiltArtifacts: cache.misses,
          durationMs: now().getTime() - startedAt.getTime(),
        };
      }

      // Index into a candidate directory, outside builds/.
      const candidate = createCandidateDirectory(loreDirectory);
      let sealed = false;
      try {
        throwIfAborted(options.signal);
        progress.start('indexing', 'Indexing');
        const db = openWritable(join(candidate.path, 'context.sqlite'));
        try {
          runMigrations(db, loadMigrations(MIGRATIONS_DIRECTORY));
          const counts = writeCatalog({
            db,
            artifacts: parsed,
            warnings: discovery.warnings.map((warning) => ({
              code: warning.code,
              class: warning.code === 'unsupported-format' ? 'unsupported-file' : 'parser',
              path: warning.path,
              message: warning.message,
            })),
          });
          progress.finish('indexing', counts.chunks);

          const manifest: BuildManifest = {
            formatVersion: 1,
            buildId,
            projectName: config.config.name,
            compilerVersion: nextLock.compiler,
            schemaVersion: nextLock.schema,
            configurationHash: hashCanonical(config.effective as unknown as Canonical),
            sourceFingerprint: fingerprint.fingerprint,
            canonicalRoots: canonicalRoots(parsed),
            capabilities: ['lexical-search', 'structured-context'],
            counts,
            warnings: discovery.warnings.map((warning) => ({
              code: warning.code,
              message: warning.message,
              ...(warning.path === '.' ? {} : { path: warning.path }),
              class:
                warning.code === 'unsupported-format'
                  ? ('unsupported-file' as const)
                  : ('parser' as const),
            })),
          };

          progress.start('validating', 'Validating');
          const report = await validateCandidate({
            db,
            objects,
            artifacts: parsed,
            manifest: manifest as unknown as Record<string, unknown>,
            secrets: secretsFromEnv(),
            integrityCheck,
            search: (database, query, limit) => searchCatalog(database, query, limit),
            countRows,
          });
          progress.finish('validating', report.checksRun.length, report.ok ? 'done' : 'failed');

          if (!report.ok) {
            throw new LoreError(
              'LORE_E_BUILD_VALIDATION',
              `The candidate build failed ${report.failures.length} check(s):\n${report.failures
                .map(
                  (failure) =>
                    `  ${failure.check}: ${failure.message}${failure.subject === undefined ? '' : ` (${failure.subject})`}`,
                )
                .join('\n')}`,
              {
                remediation:
                  'The active build is unchanged. Fix the reported problems and build again.',
                details: { failures: report.failures },
              },
            );
          }

          buildManifestSchema.parse(manifest);
          writeFileAtomic(
            join(candidate.path, 'manifest.json'),
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
          writeFileAtomic(
            join(candidate.path, 'reports', 'warnings.json'),
            `${JSON.stringify(discovery.warnings, null, 2)}\n`,
          );
          writeFileAtomic(
            join(candidate.path, 'reports', 'canonical-hashes.json'),
            `${JSON.stringify(
              {
                algorithm: 'sha256',
                canonicalizationVersion: CANONICALIZATION_VERSION,
                roots: canonicalRoots(parsed),
              },
              null,
              2,
            )}\n`,
          );
        } finally {
          db.close();
        }

        throwIfAborted(options.signal);
        progress.start('sealing', 'Sealing');
        sealCandidateDirectory(candidate, join(loreDirectory, 'builds', buildId));
        sealed = true;
        progress.finish('sealing', 1);
      } finally {
        // Any failure or cancellation removes the candidate. builds/ is never touched
        // until the seal, so the active build cannot be disturbed by a failed run.
        if (!sealed) discardCandidateDirectory(candidate);
      }

      const counts = countsOf(parsed);
      state.recordBuild({
        buildId,
        state: 'verified',
        createdAt: startedAt.toISOString(),
        counts,
      });
      writeLockfile(config.projectRoot, nextLock);

      let activated = false;
      if (options.activate !== false) {
        progress.start('activating', 'Activating');
        state.activate(buildId, () => now().toISOString());
        progress.finish('activating', 1);
        activated = true;
      }

      return {
        buildId,
        created: true,
        activated,
        counts,
        warnings: discovery.warnings.length,
        reusedArtifacts: cache.hits,
        rebuiltArtifacts: cache.misses,
        durationMs: now().getTime() - startedAt.getTime(),
      };
    } finally {
      state.close();
    }
  });
}

function canonicalRoots(
  parsed: readonly {
    artifact: { id: string; contentHash: string };
    nodes: readonly { revisionHash: string }[];
    chunks: readonly Chunk[];
    objectHash: string;
  }[],
): { artifacts: string; nodes: string; chunks: string; tables: string; objects: string } {
  return {
    artifacts: hashRoot(
      parsed.map((entry) => hashCanonical([entry.artifact.id, entry.artifact.contentHash])),
    ),
    nodes: hashRoot(parsed.flatMap((entry) => entry.nodes.map((node) => node.revisionHash))),
    chunks: hashRoot(parsed.flatMap((entry) => entry.chunks.map((chunk) => chunk.revisionHash))),
    tables: hashRoot([]),
    objects: hashRoot(parsed.map((entry) => entry.objectHash)),
  };
}

function countsOf(
  parsed: readonly { nodes: readonly unknown[]; chunks: readonly unknown[] }[],
): BuildManifest['counts'] {
  return {
    artifacts: parsed.length,
    nodes: parsed.reduce((sum, entry) => sum + entry.nodes.length, 0),
    chunks: parsed.reduce((sum, entry) => sum + entry.chunks.length, 0),
    tables: 0,
    tableRows: 0,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw new LoreError('LORE_E_CANCELLED', 'The build was cancelled.', {
    remediation: 'Nothing was changed. The previously active build is still serving.',
  });
}
