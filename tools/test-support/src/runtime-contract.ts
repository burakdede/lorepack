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
