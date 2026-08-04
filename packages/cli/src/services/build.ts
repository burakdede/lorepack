import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildMigrationsDirectory,
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
  stateMigrationsDirectory,
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
  type ResolvedArtifactRule,
  readLockfile,
  resolveRules,
  validateCandidate,
  writeLockfile,
} from '@lorepack/compiler';
import {
  type BuildId,
  type BuildManifest,
  buildManifestSchema,
  CANONICALIZATION_VERSION,
  type Canonical,
  count,
  deriveBuildId,
  hashCanonical,
  hashRoot,
  LORE_DIRECTORY,
  type LoadedConfig,
  LoreError,
  NORMALIZATION_VERSION,
  type ParsedArtifact,
  type ParsedTable,
  type ProgressBus,
  secretsFromEnv,
  writeFileAtomic,
} from '@lorepack/core';
import { parserFor } from '@lorepack/parsers';
import { checkpoint } from './cancellation.js';
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

/** The `applied_at` recorded inside every build database. See `runMigrations` below. */
const SEALED_AT = '1980-01-01T00:00:00.000Z';

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

/**
 * A file the build left out, and why. Discovery contributes the ones decided by extension,
 * fingerprinting the ones decided by content; both reach the catalog and the manifest, so
 * they survive the sources and `lore inspect warnings` can answer after they are gone.
 */
interface BuildWarning {
  readonly code: string;
  readonly class: BuildManifest['warnings'][number]['class'];
  readonly path: string;
  readonly message: string;
}

/**
 * The class a reader groups by. Both ways of being unreadable are the same fact to a user
 * ("this file is not in the build"), so they share a class and differ in code.
 */
function warningClass(code: string): BuildWarning['class'] {
  return code === 'unsupported-format' || code === 'undecodable-content'
    ? 'unsupported-file'
    : 'parser';
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
    const state = LocalStateStore.open(loreDirectory, stateMigrationsDirectory());
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
      await checkpoint(options.signal, { hasActiveBuild: active !== null });

      // Rules resolve here, before parsing, because the cache key depends on them: an
      // artifact whose declared authority changed must be reindexed even though its bytes
      // did not (architecture section 12.7). Resolving after the parse loop would let a rule
      // edit reuse a stale entry, which is the quiet failure the cache key exists to prevent.
      const ruleResolution = resolveRules({
        artifacts: fingerprint.artifacts.map((artifact) => ({
          artifactId: artifact.artifactId,
          relativePath: artifact.relativePath,
        })),
        config: config.effective,
      });
      const rulesById = new Map(ruleResolution.resolved.map((entry) => [entry.artifactId, entry]));

      const cache = new ParseCache(join(loreDirectory, 'cache', 'parse'));
      progress.start('parsing', 'Parsing', fingerprint.artifacts.length);
      const parsed: CachedParse[] = [];
      let handled = 0;

      for (const discovered of fingerprint.artifacts) {
        await checkpoint(options.signal, { hasActiveBuild: active !== null });
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
          rules: ruleResolution.canonical as unknown as Canonical,
        });

        // A hit still has to have its normalized body present: the object store and the
        // cache can be pruned independently, and reusing a parse whose body is gone would
        // produce a build that cannot answer a source read.
        const cached = cache.get(key);
        if (cached !== null && (await objects.has(cached.objectHash))) {
          parsed.push(withRules(cached, rulesById));
          handled += 1;
          continue;
        }

        const bytes = new Uint8Array(readFileSync(discovered.absolutePath));
        let result: ParsedArtifact;
        try {
          // Awaited because a parser may be asynchronous: PDF and DOCX cannot be read any
          // other way. The `await` matters for the `catch` as much as for the value, since
          // a rejected promise from an unawaited call would escape this block entirely and
          // surface as an unhandled rejection rather than as `LORE_E_PARSE_FAILED`.
          result = await parser.parse({
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
          //
          // A file whose bytes are not readable text does not reach here: fingerprinting
          // classified it and left it out with a warning, which is the other row of the
          // same table (#165).
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
          ...(result.tables === undefined || result.tables.length === 0
            ? {}
            : { tables: result.tables }),
          ...(result.warnings.length === 0 ? {} : { warnings: result.warnings }),
        };
        // A table-bearing parse is deliberately not cached. The cache is a JSON file per
        // artifact, and a 500,000-row table would write hundreds of megabytes there to save
        // a re-read that takes seconds. Rows are exactly reproducible from bytes the build
        // has already read, so the cheap thing to keep is nothing. Nothing is ever written,
        // so nothing can ever be read back missing its tables.
        if (entry.tables === undefined) cache.put(key, entry);
        parsed.push(withRules(entry, rulesById));

        handled += 1;
        if (handled % 10 === 0) progress.progress('parsing', handled, { unit: 'documents' });
      }
      progress.finish('parsing', handled);

      // One list from here on. Discovery decides an extension has no parser; parsing decides
      // the bytes are not readable text. Both are the same promise to the user, which is
      // that a file the build left out is named rather than silently missing.
      const warnings: readonly BuildWarning[] = [
        ...discovery.warnings,
        ...fingerprint.warnings,
        // What the parsers said. Discovery reports files left out; these report decisions
        // taken *inside* a file that was kept, which is the other half of the same promise:
        // a heading flattened, a column widened, a sheet not read as a table. Without this
        // every one of them was computed carefully and then dropped (#223).
        ...ruleResolution.warnings,
        ...parsed.flatMap((entry) =>
          (entry.warnings ?? []).map((warning) => ({
            code: warning.code,
            path: entry.artifact.displayPath,
            message: warning.message,
          })),
        ),
      ]
        .map((warning) => ({
          code: warning.code,
          class: warningClass(warning.code),
          path: warning.path,
          message: warning.message,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

      // Identity, derived before anything is written so the directory is named correctly.
      const buildId = deriveBuildId({
        formatVersion: 1,
        schemaVersion: nextLock.schema,
        compilerVersion: nextLock.compiler,
        canonicalizationVersion: CANONICALIZATION_VERSION,
        normalizationVersion: NORMALIZATION_VERSION,
        effectiveConfig: config.effective as unknown as Canonical,
        parserVersions: nextLock.parsers,
        ruleResolution: ruleResolution.canonical,
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
          warnings: warnings.length,
          reusedArtifacts: cache.hits,
          rebuiltArtifacts: cache.misses,
          durationMs: now().getTime() - startedAt.getTime(),
        };
      }

      // Index into a candidate directory, outside builds/.
      const candidate = createCandidateDirectory(loreDirectory);
      let sealed = false;
      try {
        await checkpoint(options.signal, { hasActiveBuild: active !== null });
        progress.start('indexing', 'Indexing');
        const db = openWritable(join(candidate.path, 'context.sqlite'));
        try {
          // A fixed timestamp, not the wall clock: a sealed build must carry no
          // operational time. Otherwise two builds of identical content differ in bytes,
          // and `.lorepack` stops being reproducible.
          runMigrations(db, loadMigrations(buildMigrationsDirectory()), () => SEALED_AT);
          const counts = writeCatalog({
            db,
            artifacts: parsed,
            warnings,
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
            // Declared from what the build contains, not from what the compiler can do. A
            // client that sees `table-query` and finds no tables has been misled about this
            // build, which is worse than not offering the capability.
            capabilities:
              counts.tables > 0
                ? ['lexical-search', 'structured-context', 'table-query']
                : ['lexical-search', 'structured-context'],
            counts,
            warnings: warnings.map((warning) => ({
              code: warning.code,
              message: warning.message,
              ...(warning.path === '.' ? {} : { path: warning.path }),
              class: warning.class,
            })),
            // Sealed with the build, so `lore inspect exclusions` and Studio can answer after
            // the sources have moved on and after a rollback, without reading a source file.
            // Not an input to `deriveBuildId`: identity is what a build contains, and two
            // builds holding the same artifacts are the same build however the rest was
            // filtered out. Warnings are already outside identity for the same reason.
            exclusions: discovery.exclusions.map((exclusion) => ({
              ...exclusion,
              sample: [...exclusion.sample],
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
              `The candidate build failed ${count(report.failures.length, 'check')}:\n${report.failures
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
            `${JSON.stringify(warnings, null, 2)}\n`,
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

        await checkpoint(options.signal, { hasActiveBuild: active !== null });
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
        warnings: warnings.length,
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
    tables?: readonly ParsedTable[];
  }[],
): { artifacts: string; nodes: string; chunks: string; tables: string; objects: string } {
  return {
    artifacts: hashRoot(
      parsed.map((entry) => hashCanonical([entry.artifact.id, entry.artifact.contentHash])),
    ),
    nodes: hashRoot(parsed.flatMap((entry) => entry.nodes.map((node) => node.revisionHash))),
    chunks: hashRoot(parsed.flatMap((entry) => entry.chunks.map((chunk) => chunk.revisionHash))),
    // Every cell, not just the schema. Section 11.4 requires a row change to change the
    // build id, and hashing only the column layout would let two builds with different data
    // share an identity, which is the one thing a build id may never do.
    tables: hashRoot(
      parsed.flatMap((entry) =>
        (entry.tables ?? []).map((table) =>
          hashCanonical([
            table.tableId,
            table.columns.map((column) => [column.name, column.type, column.nullable]),
            table.rows,
          ] as unknown as Canonical),
        ),
      ),
    ),
    objects: hashRoot(parsed.map((entry) => entry.objectHash)),
  };
}

function countsOf(
  parsed: readonly {
    nodes: readonly unknown[];
    chunks: readonly unknown[];
    tables?: readonly ParsedTable[];
  }[],
): BuildManifest['counts'] {
  const tables = parsed.flatMap((entry) => entry.tables ?? []);
  return {
    artifacts: parsed.length,
    nodes: parsed.reduce((sum, entry) => sum + entry.nodes.length, 0),
    chunks: parsed.reduce((sum, entry) => sum + entry.chunks.length, 0),
    tables: tables.length,
    // Counted from the parse rather than read back from SQLite, so this agrees with the
    // manifest on a rebuild that reused an existing build directory and wrote no rows.
    tableRows: tables.reduce((sum, table) => sum + table.rows.length, 0),
  };
}

/**
 * A parsed artifact with its declared rules applied.
 *
 * Parsers leave every artifact neutral on purpose, with a comment forbidding them from
 * inferring status or authority from content: that would be inventing truth. The declaration
 * is the user's, and this is where it lands, after parsing and before indexing.
 *
 * Applied on the cached path too. The cache key covers the resolution, so a hit already agrees
 * about the rules, but reapplying costs nothing and means the rule values in a build come from
 * one place rather than from whichever path an artifact happened to take.
 */
function withRules(
  entry: CachedParse,
  rulesById: ReadonlyMap<string, ResolvedArtifactRule>,
): CachedParse {
  const rule = rulesById.get(entry.artifact.id);
  if (rule === undefined) return entry;
  return {
    ...entry,
    artifact: {
      ...entry.artifact,
      status: rule.status,
      authority: rule.authority,
      supersedes: [...rule.supersedes],
    },
  };
}
