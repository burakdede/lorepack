import { join } from 'node:path';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import { withTempProject } from '../../../tools/test-support/src/index.ts';
import { runBuild } from '../../cli/src/services/build.js';
import { createCloudflareDeploymentTarget } from '../src/target.js';
import {
  CORPUS_ID,
  createProjectedWorkerRuntimeFixture,
  PROJECT,
} from './projected-runtime-fixture.js';

const MATCHING_QUERY = 'rollback';

async function measuredFixture() {
  const fixture = await createProjectedWorkerRuntimeFixture();
  try {
    const files: Record<string, string> = {
      'lore.yaml': `version: 1\nname: ${PROJECT}\nsources: [docs]\n`,
      'docs/products.csv': 'sku,price\nA1,19.99\nA2,4.50\n',
    };
    for (let index = 0; index < 25; index += 1) {
      files[`docs/service${index}.md`] =
        `# Rollback service${index}\n\nRollback release. ${Array.from({ length: 80 }, (_, word) => `service${index}permission${word}`).join(' ')}\n`;
    }
    await withTempProject({ files }, async (project) => {
      const built = await runBuild({
        config: loadConfig({ cwd: project.root }),
        progress: new ProgressBus(),
      });
      const target = createCloudflareDeploymentTarget({
        corpusId: CORPUS_ID,
        projectId: PROJECT,
        endpoint: 'https://example.workers.dev/mcp',
        catalogDb: fixture.projection,
        objects: fixture.bucket,
      });
      const plan = await target.plan({
        corpusId: CORPUS_ID,
        projectName: PROJECT,
        buildId: built.buildId,
        buildDirectory: join(project.root, '.lore/builds', built.buildId),
        buildCapabilities: ['lexical-search', 'structured-context', 'table-query'],
      });
      const receipt = await target.apply(plan);
      await target.verify(receipt);
      await target.activate(receipt);
    });
    const tables = await fixture.runtime.listTables();
    const table = tables[0];
    if (table === undefined) throw new Error('The compiled fixture has no typed table.');
    const description = await fixture.runtime.describeTable(table.tableId);
    const knownArtifactId = (await fixture.runtime.search({ query: MATCHING_QUERY })).hits[0]
      ?.artifactId;
    if (knownArtifactId === undefined)
      throw new Error('The compiled fixture has no rollback source.');
    const calls: Array<{ query: string }> = [];
    const prepare = fixture.projection.prepare.bind(fixture.projection);
    fixture.projection.prepare = (query) => {
      calls.push({ query });
      return prepare(query);
    };
    return {
      ...fixture,
      db: {
        calls,
        resetCalls() {
          calls.length = 0;
        },
      },
      knownArtifactId,
      knownTableId: table.tableId,
      sql: `SELECT ${description.columns.map((column) => column.sqlName).join(', ')} FROM ${description.sqlName}`,
    };
  } catch (cause) {
    await fixture.close();
    throw cause;
  }
}

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
    const fixture = await measuredFixture();
    try {
      const { runtime, db, knownArtifactId, knownTableId } = fixture;

      const countFor = async (call: () => Promise<unknown>): Promise<number> => {
        db.resetCalls();
        await call();
        return db.calls.length;
      };

      expect.soft(await countFor(() => runtime.describeBuild())).toBeLessThanOrEqual(4);
      expect
        .soft(
          await countFor(() =>
            runtime.search({
              query: MATCHING_QUERY,
              limit: 10,
              includeArchived: false,
              debug: false,
            }),
          ),
        )
        .toBeLessThanOrEqual(5);
      expect
        .soft(
          await countFor(() =>
            runtime.contextForTask({
              task: 'rollback release unmatchedterm',
              includeArchived: false,
              allowUnsupportedBudget: false,
            }),
          ),
        )
        .toBeLessThanOrEqual(5);
      expect
        .soft(await countFor(() => runtime.readSource({ artifactId: knownArtifactId })))
        .toBeLessThanOrEqual(4);
      expect.soft(await countFor(() => runtime.listTables())).toBeLessThanOrEqual(3);
      expect.soft(await countFor(() => runtime.describeTable(knownTableId))).toBeLessThanOrEqual(5);
      expect
        .soft(
          await countFor(() =>
            runtime.queryTable({
              tableId: knownTableId,
              sql: fixture.sql,
            }),
          ),
        )
        .toBeLessThanOrEqual(5);
    } finally {
      await fixture.close();
    }
  });

  it('does not fan out D1 queries with deeper context assembly', async () => {
    const fixture = await measuredFixture();
    try {
      const { runtime, db } = fixture;

      db.resetCalls();
      const bundle = await runtime.contextForTask({
        task: 'rollback release unmatchedterm',
        includeArchived: false,
        budget: 24_000,
        allowUnsupportedBudget: false,
      });

      expect(bundle.selected.length).toBeGreaterThan(0);
      expect(db.calls.length).toBeLessThanOrEqual(5);
      expect(db.calls.filter((call) => call.query.includes('FROM chunks_fts')).length).toBe(2);
    } finally {
      await fixture.close();
    }
  });
});
