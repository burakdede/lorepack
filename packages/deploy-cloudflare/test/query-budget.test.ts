import { describe, expect, it } from 'vitest';
import { createWorkerRuntimeFixture, MATCHING_QUERY } from './worker-runtime-fixture.js';

/**
 * Worker D1 query budget, verified 2026-08-08.
 *
 * These maxima include the per-request `active_build` read and the namespaced
 * `build_manifests` lookup.
 *
 * Current bounds:
 * - `describeBuild`: 4 queries
 * - `search`: 5 queries on the common path, 6 with fallback
 * - `contextForTask`: 4 queries on the common path, 5 with fallback
 * - `readSource`: 4 queries
 * - `listTables`: 3 queries
 * - `describeTable`: 5 queries
 * - `queryTable`: 5 queries
 */

describe('the Worker D1 query budget, issue 86', () => {
  it('keeps each runtime capability within its documented query maximum', async () => {
    const fixture = createWorkerRuntimeFixture({ fallbackHitCount: 25 });
    const { runtime, db, knownArtifactId, knownTableId } = fixture;

    const countFor = async (call: () => Promise<unknown>): Promise<number> => {
      db.resetCalls();
      await call();
      return db.calls.length;
    };

    expect(await countFor(() => runtime.describeBuild())).toBeLessThanOrEqual(4);
    expect(
      await countFor(() =>
        runtime.search({
          query: MATCHING_QUERY,
          limit: 10,
          includeArchived: false,
          debug: false,
        }),
      ),
    ).toBeLessThanOrEqual(5);
    expect(
      await countFor(() =>
        runtime.contextForTask({
          task: 'rollback release',
          includeArchived: false,
          allowUnsupportedBudget: false,
        }),
      ),
    ).toBeLessThanOrEqual(5);
    expect(
      await countFor(() => runtime.readSource({ artifactId: knownArtifactId })),
    ).toBeLessThanOrEqual(4);
    expect(await countFor(() => runtime.listTables())).toBeLessThanOrEqual(3);
    expect(await countFor(() => runtime.describeTable(knownTableId))).toBeLessThanOrEqual(5);
    expect(
      await countFor(() =>
        runtime.queryTable({
          tableId: knownTableId,
          sql: 'SELECT c_0_sku FROM t_products_active',
        }),
      ),
    ).toBeLessThanOrEqual(5);
  });

  it('does not fan out D1 queries with deeper context assembly', async () => {
    const fixture = createWorkerRuntimeFixture({ fallbackHitCount: 25 });
    const { runtime, db } = fixture;

    db.resetCalls();
    const bundle = await runtime.contextForTask({
      task: 'rollback release',
      includeArchived: false,
      budget: 24_000,
      allowUnsupportedBudget: false,
    });

    expect(bundle.selected.length).toBeGreaterThan(0);
    expect(db.calls.length).toBeLessThanOrEqual(5);
    expect(db.calls.filter((call) => call.query.includes('FROM chunks_fts')).length).toBe(2);
  });
});
