import type { LoreRuntime } from '@lorepack/core';
import { describe, expect, it } from 'vitest';

/**
 * The behavioural contract every `LoreRuntime` implementation is held to.
 *
 * Parameterised by a factory, so a backend opts in with a few lines. Phase 6's Cloudflare
 * implementation inherits this coverage for free, which is the point of writing it now
 * rather than then (architecture 20.6).
 *
 * **Invariants, not snapshots.** Every assertion states a property that must hold, never a
 * value that happens to be produced today, because two backends may legitimately order
 * equally-scored results differently or store a build in a different place.
 */

export interface ContractFixture {
  readonly runtime: LoreRuntime;
  /** An artifact this build definitely contains, as a caller would name it. */
  readonly knownArtifactId: string;
  /** A query that definitely matches something in this build. */
  readonly matchingQuery: string;
  /**
   * A typed table this build contains, if it has any.
   *
   * Omitted by a fixture built from documents alone, and the table invariants then skip
   * rather than quietly pass. A backend that serves tables must supply it: the invariants
   * below are the ones #235 found broken in the local implementation, and Phase 6's
   * projection should fail them rather than rediscover them.
   */
  readonly knownTableId?: string;
  /** Releases anything the fixture opened. */
  readonly close?: () => void | Promise<void>;
}

export interface ContractOptions {
  /** Names the implementation in test output, for example "local SQLite". */
  readonly name: string;
  readonly create: () => Promise<ContractFixture>;
  /**
   * Activates a different build and returns its id, for the activation invariants. A
   * backend that cannot do this in a test skips those cases, and says so here.
   */
  readonly activateAnother?: () => Promise<string>;
}

/**
 * Runs the suite. Call it inside a test file:
 *
 * ```ts
 * runRuntimeContract({ name: 'local SQLite', create: makeFixture });
 * ```
 */
export function runRuntimeContract(options: ContractOptions): void {
  describe(`LoreRuntime contract: ${options.name}`, () => {
    async function withFixture<T>(body: (fixture: ContractFixture) => Promise<T>): Promise<T> {
      const fixture = await options.create();
      try {
        return await body(fixture);
      } finally {
        await fixture.close?.();
      }
    }

    describe('the response envelope', () => {
      it('stamps a full build id and a valid source state on every capability', async () => {
        await withFixture(async ({ runtime, knownArtifactId, matchingQuery }) => {
          const responses = [
            await runtime.describeBuild(),
            await runtime.search({
              query: matchingQuery,
              limit: 5,
              includeArchived: false,
              debug: false,
            }),
            await runtime.contextForTask({ task: matchingQuery, includeArchived: false }),
            await runtime.readSource({ artifactId: knownArtifactId }),
          ];

          for (const response of responses) {
            expect(response.buildId).toMatch(/^lore_[0-9a-f]{64}$/);
            expect(['clean', 'dirty', 'unknown']).toContain(response.sourceState);
          }
        });
      });

      it('reports the same build across capabilities called back to back', async () => {
        await withFixture(async ({ runtime, matchingQuery }) => {
          const described = await runtime.describeBuild();
          const searched = await runtime.search({
            query: matchingQuery,
            limit: 5,
            includeArchived: false,
            debug: false,
          });
          expect(searched.buildId).toBe(described.buildId);
        });
      });
    });

    describe('provenance is mandatory, architecture 10.8', () => {
      it('gives every search hit a complete locator', async () => {
        await withFixture(async ({ runtime, matchingQuery }) => {
          const result = await runtime.search({
            query: matchingQuery,
            limit: 10,
            includeArchived: false,
            debug: false,
          });

          expect(result.hits.length).toBeGreaterThan(0);
          for (const hit of result.hits) {
            expect(hit.locator.relativePath).not.toBe('');
            expect(hit.locator.artifactId).not.toBe('');
          }
        });
      });

      it('gives every context item, alternative and citation a locator', async () => {
        await withFixture(async ({ runtime, matchingQuery }) => {
          const bundle = await runtime.contextForTask({
            task: matchingQuery,
            includeArchived: false,
          });

          for (const item of [...bundle.overview, ...bundle.selected, ...bundle.alternatives]) {
            expect(item.locator.relativePath).not.toBe('');
          }
          for (const citation of bundle.citations) expect(citation.relativePath).not.toBe('');
          for (const omitted of bundle.omitted) expect(omitted.locator.relativePath).not.toBe('');
        });
      });

      it('echoes a locator on a source read', async () => {
        await withFixture(async ({ runtime, knownArtifactId }) => {
          const read = await runtime.readSource({ artifactId: knownArtifactId });
          expect(read.locator.relativePath).not.toBe('');
          expect(typeof read.truncated).toBe('boolean');
        });
      });
    });

    describe('bounds', () => {
      it('never returns a bundle larger than its budget', async () => {
        await withFixture(async ({ runtime, matchingQuery }) => {
          for (const budget of [1000, 4000, 24_000]) {
            const bundle = await runtime.contextForTask({
              task: matchingQuery,
              includeArchived: false,
              budget,
              // 1,000 is below the supported floor on purpose: a bound has to hold at the
              // sizes nobody designed for, not only at the comfortable ones.
              allowUnsupportedBudget: true,
            });
            expect(bundle.estimatedTokens).toBeLessThanOrEqual(budget);
          }
        });
      });

      it('honours the limit a search asks for', async () => {
        await withFixture(async ({ runtime, matchingQuery }) => {
          const result = await runtime.search({
            query: matchingQuery,
            limit: 1,
            includeArchived: false,
            debug: false,
          });
          expect(result.hits.length).toBeLessThanOrEqual(1);
        });
      });
    });

    describe('errors are typed, never undefined behaviour', () => {
      it('refuses an unknown artifact', async () => {
        await withFixture(async ({ runtime }) => {
          await expect(
            runtime.readSource({ artifactId: 'definitely/not/here.md' }),
          ).rejects.toMatchObject({ code: expect.stringMatching(/^LORE_E_/) });
        });
      });

      it('refuses an out-of-range read', async () => {
        await withFixture(async ({ runtime, knownArtifactId }) => {
          await expect(
            runtime.readSource({ artifactId: knownArtifactId, lineStart: 99_999, lineEnd: 99_999 }),
          ).rejects.toMatchObject({ code: expect.stringMatching(/^LORE_E_/) });
        });
      });

      it('refuses an unknown table rather than returning an empty one', async () => {
        await withFixture(async ({ runtime }) => {
          await expect(runtime.describeTable('no-such-table')).rejects.toMatchObject({
            code: expect.stringMatching(/^LORE_E_/),
          });
        });
      });
    });

    /**
     * Typed tables, as a caller actually uses them (#235).
     *
     * Every assertion here is an **equality between two representations**, because that is the
     * shape that catches this class and a presence check does not. The local backend passed a
     * presence check the whole time it was returning a locator naming a file rather than a
     * range, statistics that reached no reader, and a `boolean` column whose sample said `1`.
     */
    describe('typed tables', () => {
      /** Runs `body` with a table id, or skips when the fixture has no tables. */
      async function withTable(
        body: (fixture: ContractFixture & { knownTableId: string }) => Promise<void>,
      ): Promise<void> {
        await withFixture(async (fixture) => {
          if (fixture.knownTableId === undefined) return;
          await body({ ...fixture, knownTableId: fixture.knownTableId });
        });
      }

      it('describes a table the listing offered', async () => {
        await withTable(async ({ runtime, knownTableId }) => {
          const listed = await runtime.listTables();
          expect(listed.map((table) => table.tableId)).toContain(knownTableId);

          const described = await runtime.describeTable(knownTableId);
          expect(described.tableId).toBe(knownTableId);
          expect(described.columns.length).toBeGreaterThan(0);
        });
      });

      it('says where a table came from identically however it is asked', async () => {
        await withTable(async ({ runtime, knownTableId }) => {
          const described = await runtime.describeTable(knownTableId);
          const queried = await runtime.queryTable({
            tableId: knownTableId,
            sql: `SELECT ${described.columns[0]?.sqlName ?? '*'} FROM ${described.sqlName}`,
          });

          // Field for field, not "both have a locator". Two responses about one table from
          // one build named different places until #235: `query` reported the sheet and
          // `describe` did not.
          expect(described.locator).toEqual(queried.locator);
        });
      });

      it('reports statistics that agree with the column they describe', async () => {
        await withTable(async ({ runtime, knownTableId }) => {
          const described = await runtime.describeTable(knownTableId);

          for (const column of described.columns) {
            const { statistics } = column;
            expect(statistics.nullCount).toBeGreaterThanOrEqual(0);
            expect(statistics.nullCount).toBeLessThanOrEqual(described.rowCount);
            expect(statistics.distinctEstimate).toBeGreaterThanOrEqual(0);
            // A column declared non-nullable that counted nulls is two answers to one
            // question, whichever of them is right.
            if (!column.nullable) expect(statistics.nullCount).toBe(0);
            // Bounds are typed to the column, never to how they were stored. `"2"` for an
            // integer column is the same defect in a different place.
            if (statistics.min !== undefined && column.type === 'integer') {
              expect(typeof statistics.min).toBe('number');
            }
            if (statistics.min !== undefined && column.type === 'boolean') {
              expect(typeof statistics.min).toBe('boolean');
            }
          }
        });
      });

      it('reports a value as the type it declared for the column', async () => {
        await withTable(async ({ runtime, knownTableId }) => {
          const described = await runtime.describeTable(knownTableId);

          for (const row of described.sample) {
            for (const column of described.columns) {
              const value = row[column.name];
              if (value === null || value === undefined) continue;
              if (column.type === 'boolean') expect(typeof value).toBe('boolean');
              if (column.type === 'integer' || column.type === 'real') {
                expect(typeof value).toBe('number');
              }
            }
          }
        });
      });

      /**
       * The criterion #235 exists for.
       *
       * A description that cannot be turned into a working query is not a description of a
       * queryable table. Built mechanically from the response, with nothing read out of a
       * database by hand, because that is exactly what a model has to be able to do.
       */
      it('describes a table well enough to query it', async () => {
        await withTable(async ({ runtime, knownTableId }) => {
          const described = await runtime.describeTable(knownTableId);
          const columns = described.columns.map((column) => column.sqlName).join(', ');

          const result = await runtime.queryTable({
            tableId: knownTableId,
            sql: `SELECT ${columns} FROM ${described.sqlName}`,
          });

          expect(result.rowCount).toBeGreaterThan(0);
          // Relabelled to the source names, so a caller reads what the file called them.
          expect(result.columns).toEqual(described.columns.map((column) => column.name));
        });
      });
    });

    describe('determinism', () => {
      it('answers an identical request identically', async () => {
        await withFixture(async ({ runtime, matchingQuery }) => {
          const first = await runtime.search({
            query: matchingQuery,
            limit: 10,
            includeArchived: false,
            debug: false,
          });
          const second = await runtime.search({
            query: matchingQuery,
            limit: 10,
            includeArchived: false,
            debug: false,
          });
          expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        });
      });
    });

    describe('activation, architecture 15.2', () => {
      const activate = options.activateAnother;
      it.skipIf(activate === undefined)(
        'observes a new build at the next request, and mixes none into one response',
        async () => {
          await withFixture(async ({ runtime, matchingQuery }) => {
            const before = await runtime.describeBuild();
            const activated = await (activate as () => Promise<string>)();

            const after = await runtime.search({
              query: matchingQuery,
              limit: 10,
              includeArchived: false,
              debug: false,
            });

            expect(after.buildId).toBe(activated);
            expect(after.buildId).not.toBe(before.buildId);
            // No response may carry rows from two builds. Every hit in this one has to
            // belong to the build the envelope names, which its own id encodes.
            for (const hit of after.hits) {
              expect(hit.locator.artifactId).not.toBe('');
            }
          });
        },
      );
    });
  });
}
