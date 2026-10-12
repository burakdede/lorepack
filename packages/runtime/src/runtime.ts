import {
  type BuildDescription,
  type BuildHandle,
  type BuildScope,
  type BuildSelection,
  buildSelectionSchema,
  type CatalogSearchCriteria,
  type CatalogSearchHit,
  type ContextBundle,
  candidateCount,
  LoreError,
  type LoreRuntime,
  RANKING_WEIGHTS,
  type RuntimeDeps,
  type RuntimeIdentity,
  runtimeIdentitySchema,
  type SearchRequest,
  type SearchResult,
  type SourceReadRequest,
  type SourceReadResult,
  type SourceState,
  searchRequestSchema,
  sourceReadRequestSchema,
  type TableDescription,
  type TableQueryRequest,
  type TableQueryResult,
  type TaskContextRequest,
  tableQueryRequestSchema,
  taskContextRequestSchema,
} from '@lorepack/core/worker';
import type { ZodType } from 'zod';
import { assembleBundle, DEFAULT_PROFILE, resolveBudget } from './context/assemble.js';
import { identifyExecution, resolveExecutionPolicy } from './context/execution.js';
import { rankCandidates, rankWithReport } from './ranking/rank.js';
import { readSourceFrom } from './read-source.js';

/**
 * The runtime: one implementation of architecture 13.1 over ports, for every consumer.
 *
 * Three things live here rather than in each transport, because a transport that forgets
 * any of them is a defect nobody notices until a model reads the wrong build:
 *
 * 1. **The handle.** Acquired once per call, used for the whole call, released in a
 *    `finally`. Activation is therefore observed at the next request boundary, and a call
 *    already in flight finishes against the build it captured (architecture 15.2).
 * 2. **The envelope.** `buildId` and `sourceState` are stamped from the handle and the
 *    freshness provider, not from anything a caller passes, so no response can omit them
 *    or disagree with the data it carries.
 * 3. **The identity assertion.** The scope a backend opens must be the build the handle
 *    named. Rows from two builds in one response is the audit finding this boundary exists
 *    to prevent, so it is checked rather than assumed.
 */

export interface RuntimeOptions extends RuntimeDeps {
  readonly buildId?: BuildHandle['buildId'];
}

export function createRuntime(deps: RuntimeOptions): LoreRuntime {
  return new PortedRuntime(deps);
}

/** What every capability needs: an open scope, and the envelope to stamp on the way out. */
interface Call {
  readonly scope: BuildScope;
  readonly handle: BuildHandle;
  readonly envelope: RuntimeIdentity & {
    readonly buildId: BuildHandle['buildId'];
    readonly sourceState: SourceState;
  };
}

class PortedRuntime implements LoreRuntime {
  readonly #deps: RuntimeOptions;

  constructor(deps: RuntimeOptions) {
    this.#deps = deps;
  }

  async describeBuild(selection: BuildSelection = {}): Promise<BuildDescription> {
    return this.#withBuild(async ({ scope, envelope }) => {
      const manifest = await scope.catalog.manifest();
      return {
        ...envelope,
        projectName: manifest.projectName,
        shortBuildId: manifest.buildId.slice(0, 17),
        capabilities: [...manifest.capabilities],
        counts: { ...manifest.counts },
        warningCount: await scope.catalog.countWarnings(),
        schemaVersion: manifest.schemaVersion,
        compilerVersion: manifest.compilerVersion,
        ...(scope.createdAt === undefined ? {} : { createdAt: scope.createdAt }),
      };
    }, selection);
  }

  async search(unchecked: SearchRequest): Promise<SearchResult> {
    const request = checked(searchRequestSchema, unchecked);
    return this.#withBuild(
      async ({ scope, envelope }) => {
        // Ranking can only reorder what it was given, so the index is asked for more than
        // the page: a page of ten taken straight from BM25 would make every boost decorative.
        const candidates = await candidatesFor(scope, request.query, {
          limit: candidateCount(request.limit),
          pathGlob: request.pathGlob,
          extension: request.fileType,
          statuses: request.status,
          artifactId: request.artifactId,
        });

        const ranked = rankCandidates(candidates.hits, {
          query: request.query,
          limit: request.limit,
          includeArchived: request.includeArchived,
          superseded: await scope.catalog.supersededArtifacts(),
        });

        return {
          ...envelope,
          totalIndexedChunks: await scope.catalog.countChunks(),
          hits: ranked.map(({ hit, score, components, labels }) => ({
            chunkId: hit.chunkId,
            artifactId: hit.artifactId,
            /**
             * The composed relevance score, higher being better. It is a heuristic about
             * how well this chunk matches the words asked for, and it is not a confidence
             * and not evidence the content is correct (architecture 13.2).
             */
            score,
            excerpt: hit.excerpt,
            headingPath: [...hit.headingPath],
            status: hit.status,
            labels,
            // Provenance is mandatory (architecture 10.8). The locator is built from the
            // same row as the hit, so a result cannot exist without one.
            locator: {
              artifactId: hit.artifactId,
              relativePath: hit.relativePath,
              ...(hit.headingPath.length === 0 ? {} : { headingPath: [...hit.headingPath] }),
              ...(hit.sheet === null ? {} : { sheet: hit.sheet }),
              ...(hit.cellRange === null ? {} : { cellRange: hit.cellRange }),
              // A page and a line range are alternatives, not companions: a format has one
              // coordinate or the other, and carrying an invented one alongside the real one
              // is what made a PDF citation read as line 1 (#241).
              ...(hit.page === null || hit.page <= 0 ? {} : { page: hit.page }),
              ...(hit.lineStart === null || hit.lineStart <= 0 ? {} : { lineStart: hit.lineStart }),
              ...(hit.lineEnd === null || hit.lineEnd <= 0 ? {} : { lineEnd: hit.lineEnd }),
            },
            ...(request.debug ? { scoreComponents: components } : {}),
          })),
        };
      },
      { buildId: request.buildId },
    );
  }

  async contextForTask(unchecked: TaskContextRequest): Promise<ContextBundle> {
    const request = checked(taskContextRequestSchema, unchecked);
    return this.#withBuild(
      async ({ scope, envelope }) => {
        const profile = request.profile ?? DEFAULT_PROFILE;
        const budget = resolveBudget(profile, request.budget, request.allowUnsupportedBudget);

        // A bundle is filled from a much deeper candidate list than a page of search
        // results: the budget, not a page size, is what decides how much fits.
        const candidates = await candidatesFor(scope, request.task, {
          limit: RANKING_WEIGHTS.candidates.maximum,
          ...filtersOf(request),
        });
        const superseded = await scope.catalog.supersededArtifacts();

        const report = rankWithReport(candidates.hits, {
          query: request.task,
          limit: candidates.hits.length,
          includeArchived: request.includeArchived,
          superseded,
        });
        // Historical text is offered only after explicit expansion. Default omissions retain locators.
        const suppressed = request.includeArchived
          ? report.dropped
              .filter(
                ({ ranked }) =>
                  ranked.labels.includes('archived') || ranked.labels.includes('superseded'),
              )
              .map(({ ranked }) => ranked)
          : [];

        const manifest = await scope.catalog.manifest();
        const execution = await identifyExecution(
          resolveExecutionPolicy({
            profile,
            budget,
            includeArchived: request.includeArchived,
            compilerVersion: manifest.compilerVersion,
          }),
          {
            corpusId: scope.corpusId,
            namespaceId: scope.namespaceId,
            buildId: scope.buildId,
            task: request.task,
            filters: request.filters ?? [],
          },
        );
        return {
          ...envelope,
          execution,
          ...assembleBundle({
            task: request.task,
            profile,
            budget,
            candidateLimit: candidates.limit,
            candidateLimitHit: candidates.hits.length >= candidates.limit,
            candidateMatchMode: candidates.matchMode,
            ranked: report.kept,
            dropped: report.dropped,
            suppressed,
          }),
        };
      },
      { buildId: request.buildId },
    );
  }

  async readSource(unchecked: SourceReadRequest): Promise<SourceReadResult> {
    const request = checked(sourceReadRequestSchema, unchecked);
    return this.#withBuild(
      async ({ scope, envelope }) => ({
        ...envelope,
        ...(await readSourceFrom(scope, request)),
      }),
      { buildId: request.buildId },
    );
  }

  async listTables(
    selection: BuildSelection = {},
  ): Promise<readonly { readonly tableId: string; readonly name: string }[]> {
    return this.#withBuild(async ({ scope }) => scope.tables.list(), selection);
  }

  async describeTable(tableId: string, selection: BuildSelection = {}): Promise<TableDescription> {
    return this.#withBuild(async ({ scope, envelope }) => {
      const description = await scope.tables.describe(tableId);
      if (description === null) {
        throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No table ${tableId} in this build.`, {
          remediation: 'Run `lorepack inspect build` to see which capabilities this build has.',
          subject: tableId,
        });
      }
      return { ...description, ...envelope };
    }, selection);
  }

  async queryTable(unchecked: TableQueryRequest): Promise<TableQueryResult> {
    const request = checked(tableQueryRequestSchema, unchecked);
    return this.#withBuild(
      async ({ scope, envelope }) => ({
        ...(await scope.tables.query(request)),
        ...envelope,
      }),
      { buildId: request.buildId },
    );
  }

  /**
   * One handle, one scope, one envelope, released whatever happens.
   *
   * Freshness is read before the body rather than after, so a slow capability cannot
   * report a state observed at a different moment than the data it returns. It never
   * fails the call: a source tree that cannot be inspected yields `unknown` (#147).
   */
  async #withBuild<T>(
    body: (call: Call) => Promise<T>,
    unchecked: BuildSelection = {},
  ): Promise<T> {
    const requested = checked(buildSelectionSchema, unchecked);
    if (
      this.#deps.buildId !== undefined &&
      requested.buildId !== undefined &&
      requested.buildId !== this.#deps.buildId
    ) {
      throw new LoreError(
        'LORE_E_INVALID_ARGUMENT',
        'This runtime serves a different selected build.',
        {
          remediation: 'Use the build configured for this server.',
          subject: requested.buildId,
        },
      );
    }
    const selection = {
      buildId: requested.buildId ?? this.#deps.buildId,
    };
    const handle = await this.#deps.provider.acquire(selection);
    try {
      if (selection.buildId !== undefined && handle.buildId !== selection.buildId) {
        throw new LoreError(
          'LORE_E_BUILD_NOT_FOUND',
          'The runtime did not acquire the selected build.',
          {
            remediation:
              'Use a provider that supports exact retained-build selection. No active fallback is permitted.',
            subject: selection.buildId,
          },
        );
      }
      const identity = runtimeIdentitySchema.safeParse({
        corpusId: handle.corpusId,
        namespaceId: handle.namespaceId,
      });
      if (!identity.success) {
        throw new LoreError(
          'LORE_E_SCHEMA_MISMATCH',
          'The runtime provider returned an invalid corpus or namespace identity.',
          {
            remediation: 'Use a runtime adapter that implements the current identity contract.',
          },
        );
      }
      const scope = await this.#deps.open(handle);
      if (
        scope.buildId !== handle.buildId ||
        scope.corpusId !== handle.corpusId ||
        scope.namespaceId !== handle.namespaceId
      ) {
        throw new LoreError(
          'LORE_E_INTERNAL',
          'The storage backend opened a different build or runtime binding than this request acquired.',
          {
            remediation: 'This is a defect in the storage adapter. Please report it.',
            subject: `${handle.buildId} acquired, ${scope.buildId} opened`,
          },
        );
      }

      const sourceState =
        selection.buildId !== undefined &&
        (await this.#deps.provider.current())?.buildId !== handle.buildId
          ? 'unknown'
          : await this.#freshness();
      return await body({
        scope,
        handle,
        envelope: {
          corpusId: handle.corpusId,
          namespaceId: handle.namespaceId,
          buildId: handle.buildId,
          sourceState,
        },
      });
    } finally {
      await handle.release();
    }
  }

  async #freshness(): Promise<SourceState> {
    if (this.#deps.freshness === undefined) return 'unknown';
    try {
      return await this.#deps.freshness();
    } catch {
      // A read of a sealed build is never failed by the source tree. Anything the provider
      // could not establish is `unknown`, which the contract has a value for precisely so
      // this case does not need an exception.
      return 'unknown';
    }
  }
}

/**
 * A request, held to the shared contract before any storage is asked (#554).
 *
 * REST and MCP validate the same schemas at their boundary, but the runtime is the one place
 * every caller passes through, the CLI and an embedding host included. Bounds checked here
 * hold for every backend, which is what keeps an oversized glob away from SQLite and a list
 * of statuses under D1's bound-parameter limit.
 */
function checked<T>(schema: ZodType<T>, request: unknown): T {
  const result = schema.safeParse(request);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const path = first === undefined ? '' : first.path.join('.');
  throw new LoreError(
    'LORE_E_INVALID_ARGUMENT',
    `The request is invalid${path === '' ? '' : ` at \`${path}\``}: ${first?.message ?? 'unknown reason'}.`,
    {
      remediation: 'Correct the named field and try again.',
      ...(path === '' ? {} : { subject: path }),
    },
  );
}

/** Request filters, translated into the criteria the catalog understands. */
function filtersOf(request: TaskContextRequest): {
  pathGlob?: string;
  extension?: string;
  statuses?: readonly ('active' | 'draft' | 'archived')[];
} {
  const filters = request.filters ?? [];
  const path = filters.find((filter) => filter.kind === 'path')?.value;
  const type = filters.find((filter) => filter.kind === 'type')?.value;
  const statuses = filters
    .filter((filter) => filter.kind === 'status')
    .map((filter) => filter.value as 'active' | 'draft' | 'archived');

  return {
    ...(path === undefined ? {} : { pathGlob: path }),
    ...(type === undefined ? {} : { extension: type }),
    ...(statuses.length === 0 ? {} : { statuses }),
  };
}

/**
 * Candidates for a query, precise first and broad second.
 *
 * Every term in one chunk is what a keyword search means, and it is the right default.
 * It is also the wrong question for a sentence: no chunk in any corpus contains all of
 * "how do I roll back a release", so a task asked that way returns nothing at all, which
 * is what the first implementation of `contextForTask` did.
 *
 * So: ask for all terms, and if the index has nothing, ask again for any of them and let
 * ranking decide what is relevant. Two fixed steps, no heuristics, so the same query on
 * the same build still produces the same candidates (invariant 3).
 */
async function candidatesFor(
  scope: BuildScope,
  query: string,
  criteria: Omit<CatalogSearchCriteria, 'match'>,
): Promise<{
  readonly hits: readonly CatalogSearchHit[];
  readonly limit: number;
  readonly matchMode: 'all' | 'any';
}> {
  const precise = await scope.catalog.search(query, { ...criteria, match: 'all' });
  const limit = criteria.limit;
  if (precise.length > 0 || query.trim().split(/\s+/).length < 2) {
    return { hits: precise, limit, matchMode: 'all' };
  }
  return {
    hits: await scope.catalog.search(query, { ...criteria, match: 'any' }),
    limit,
    matchMode: 'any',
  };
}
