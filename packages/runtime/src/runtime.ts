import {
  type BuildDescription,
  type BuildHandle,
  type BuildScope,
  type ContextBundle,
  LoreError,
  type LoreRuntime,
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
      };
    });
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    return this.#withBuild(async ({ scope, envelope }) => {
      const hits = await scope.catalog.search(request.query, {
        limit: request.limit,
        pathGlob: request.pathGlob,
        extension: request.fileType,
        statuses: request.status,
      });

      return {
        ...envelope,
        totalIndexedChunks: await scope.catalog.countChunks(),
        hits: hits.map((hit) => ({
          chunkId: hit.chunkId,
          artifactId: hit.artifactId,
          // Raw BM25, reported as produced. A comparable relevance figure is #42's job,
          // and manufacturing one here would be inventing truth (invariant 6).
          score: hit.bm25,
          excerpt: hit.excerpt,
          headingPath: [...hit.headingPath],
          status: hit.status,
          labels: labelsFor(hit.status),
          // Provenance is mandatory (architecture 10.8). The locator is built from the
          // same row as the hit, so a result cannot exist without one.
          locator: {
            artifactId: hit.artifactId,
            relativePath: hit.relativePath,
            ...(hit.headingPath.length === 0 ? {} : { headingPath: [...hit.headingPath] }),
            ...(hit.lineStart === null || hit.lineStart <= 0 ? {} : { lineStart: hit.lineStart }),
            ...(hit.lineEnd === null || hit.lineEnd <= 0 ? {} : { lineEnd: hit.lineEnd }),
          },
        })),
      };
    });
  }

  async contextForTask(_request: TaskContextRequest): Promise<ContextBundle> {
    return this.#withBuild(async () => {
      throw notYet('contextForTask', 42);
    });
  }

  async readSource(_request: SourceReadRequest): Promise<SourceReadResult> {
    return this.#withBuild(async () => {
      throw notYet('readSource', 44);
    });
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

function labelsFor(status: string): SearchResult['hits'][number]['labels'] {
  return status === 'draft' || status === 'archived' || status === 'superseded' ? [status] : [];
}

/**
 * A capability whose ticket lands later in this phase.
 *
 * Typed and specific rather than a bare throw: a caller sees which capability is missing
 * and which issue delivers it, and the contract suite in #52 will fail on any of these
 * that survive to the end of the phase.
 */
function notYet(capability: string, issue: number): LoreError {
  return new LoreError('LORE_E_INTERNAL', `${capability} is not implemented yet.`, {
    remediation: `This capability arrives in this phase, in issue #${issue}.`,
    subject: capability,
  });
}
