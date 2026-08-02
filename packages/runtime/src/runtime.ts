import {
  type BuildDescription,
  type BuildHandle,
  type BuildScope,
  type CatalogSearchCriteria,
  type CatalogSearchHit,
  type ContextBundle,
  candidateCount,
  LoreError,
  type LoreRuntime,
  RANKING_WEIGHTS,
  type RuntimeDeps,
  type SearchRequest,
  type SearchResult,
  type SourceReadRequest,
  type SourceReadResult,
  type SourceState,
  type TableDescription,
  type TableQueryRequest,
  type TableQueryResult,
  type TaskContextRequest,
} from '@lorepack/core';
import { assembleBundle, DEFAULT_PROFILE, resolveBudget } from './context/assemble.js';
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

export interface RuntimeOptions extends RuntimeDeps {}

export function createRuntime(deps: RuntimeOptions): LoreRuntime {
  return new PortedRuntime(deps);
}

/** What every capability needs: an open scope, and the envelope to stamp on the way out. */
interface Call {
  readonly scope: BuildScope;
  readonly handle: BuildHandle;
  readonly envelope: {
    readonly buildId: BuildHandle['buildId'];
    readonly sourceState: SourceState;
  };
}

class PortedRuntime implements LoreRuntime {
  readonly #deps: RuntimeOptions;

  constructor(deps: RuntimeOptions) {
    this.#deps = deps;
  }

  async describeBuild(): Promise<BuildDescription> {
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
    });
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    return this.#withBuild(async ({ scope, envelope }) => {
      // Ranking can only reorder what it was given, so the index is asked for more than
      // the page: a page of ten taken straight from BM25 would make every boost decorative.
      const candidates = await candidatesFor(scope, request.query, {
        limit: candidateCount(request.limit),
        pathGlob: request.pathGlob,
        extension: request.fileType,
        statuses: request.status,
      });

      const ranked = rankCandidates(candidates, {
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
            ...(hit.lineStart === null || hit.lineStart <= 0 ? {} : { lineStart: hit.lineStart }),
            ...(hit.lineEnd === null || hit.lineEnd <= 0 ? {} : { lineEnd: hit.lineEnd }),
          },
          ...(request.debug ? { scoreComponents: components } : {}),
        })),
      };
    });
  }

  async contextForTask(request: TaskContextRequest): Promise<ContextBundle> {
    return this.#withBuild(async ({ scope, envelope }) => {
      const profile = request.profile ?? DEFAULT_PROFILE;
      const budget = resolveBudget(profile, request.budget);

      // A bundle is filled from a much deeper candidate list than a page of search
      // results: the budget, not a page size, is what decides how much fits.
      const candidates = await candidatesFor(scope, request.task, {
        limit: RANKING_WEIGHTS.candidates.maximum,
        ...filtersOf(request),
      });
      const superseded = await scope.catalog.supersededArtifacts();

      const report = rankWithReport(candidates, {
        query: request.task,
        limit: candidates.length,
        includeArchived: request.includeArchived,
        superseded,
      });
      // What ranking held back, offered as alternatives with their labels. Suppression is
      // not silence: anything not offered is still named in the omission report.
      const suppressed = report.dropped
        .filter(({ reason }) => reason === 'archived' || reason === 'superseded')
        .map(({ ranked }) => ranked);

      return {
        ...envelope,
        ...assembleBundle({
          task: request.task,
          profile,
          budget,
          ranked: report.kept,
          dropped: report.dropped,
          suppressed,
        }),
      };
    });
  }

  async readSource(request: SourceReadRequest): Promise<SourceReadResult> {
    return this.#withBuild(async ({ scope, envelope }) => ({
      ...envelope,
      ...(await readSourceFrom(scope, request)),
    }));
  }

  async listTables(): Promise<readonly { readonly tableId: string; readonly name: string }[]> {
    return this.#withBuild(async ({ scope }) => scope.tables.list());
  }

  async describeTable(tableId: string): Promise<TableDescription> {
    return this.#withBuild(async ({ scope, envelope }) => {
      const description = await scope.tables.describe(tableId);
      if (description === null) {
        throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No table ${tableId} in this build.`, {
          remediation: 'Run `lore inspect build` to see which capabilities this build has.',
          subject: tableId,
        });
      }
      return { ...description, ...envelope };
    });
  }

  async queryTable(request: TableQueryRequest): Promise<TableQueryResult> {
    return this.#withBuild(async ({ scope, envelope }) => ({
      ...(await scope.tables.query(request)),
      ...envelope,
    }));
  }

  /**
   * One handle, one scope, one envelope, released whatever happens.
   *
   * Freshness is read before the body rather than after, so a slow capability cannot
   * report a state observed at a different moment than the data it returns. It never
   * fails the call: a source tree that cannot be inspected yields `unknown` (#147).
   */
  async #withBuild<T>(body: (call: Call) => Promise<T>): Promise<T> {
    const handle = await this.#deps.provider.acquire();
    try {
      const scope = await this.#deps.open(handle);
      if (scope.buildId !== handle.buildId) {
        throw new LoreError(
          'LORE_E_INTERNAL',
          'The storage backend opened a different build than the one this request acquired.',
          {
            remediation: 'This is a defect in the storage adapter. Please report it.',
            subject: `${handle.buildId} acquired, ${scope.buildId} opened`,
          },
        );
      }

      const sourceState = await this.#freshness();
      return await body({
        scope,
        handle,
        envelope: { buildId: handle.buildId, sourceState },
      });
    } finally {
      handle.release();
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
): Promise<readonly CatalogSearchHit[]> {
  const precise = await scope.catalog.search(query, { ...criteria, match: 'all' });
  if (precise.length > 0) return precise;
  if (query.trim().split(/\s+/).length < 2) return precise;
  return scope.catalog.search(query, { ...criteria, match: 'any' });
}
