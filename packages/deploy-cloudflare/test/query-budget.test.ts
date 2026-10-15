import { join } from 'node:path';
import { type ContextBundle, loadConfig, ProgressBus } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import { withTempProject } from '../../../tools/test-support/src/index.ts';
import { runBuild } from '../../cli/src/services/build.js';
import { createCloudflareDeploymentTarget } from '../src/target.js';
import { createCloudflareWorkerFromBindings } from '../src/worker-app.js';
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
    const { tables } = await fixture.runtime.listTables();
    const table = tables[0];
    if (table === undefined) throw new Error('The compiled fixture has no typed table.');
    const description = await fixture.runtime.describeTable(table.tableId);
    const knownArtifactId = (
      await fixture.runtime.search({
        query: MATCHING_QUERY,
        limit: 10,
        includeArchived: false,
        debug: false,
      })
    ).hits[0]?.artifactId;
    if (knownArtifactId === undefined)
      throw new Error('The compiled fixture has no rollback source.');
    const calls: Array<{ query: string }> = [];
    const prepare = fixture.projection.prepare.bind(fixture.projection);
    fixture.projection.prepare = (query) => {
      calls.push({ query });
      return prepare(query);
    };
    const worker = createCloudflareWorkerFromBindings({
      CATALOG_DB: fixture.projection,
      TABLES_DB: fixture.projection,
      OBJECTS: fixture.bucket,
      PROJECT_ID: PROJECT,
    });
    const request = async (path: string, payload?: unknown): Promise<Response> => {
      return await worker.fetch(
        new Request(`https://budget.workers.dev${path}`, {
          ...(payload === undefined
            ? {}
            : {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              }),
        }),
      );
    };
    return {
      ...fixture,
      request,
      close: async () => {
        try {
          await worker.close();
        } finally {
          await fixture.close();
        }
      },
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
 * Runtime D1 query maxima through the actual Worker HTTP assembly, verified 2026-10-12.
 * Authorization is disabled for this capability-cost measurement; authentication and rate
 * admission have their own suites. The producer is removed before any serving measurement.
 */
describe('the Worker D1 query budget, issue 86', () => {
  it('keeps each runtime capability within its documented query maximum', async () => {
    const fixture = await measuredFixture();
    try {
      const tablePath = `/v1/tables/${encodeURIComponent(fixture.knownTableId)}`;
      const probes = [
        { path: '/v1/build', maximum: 4 },
        {
          path: '/v1/search',
          maximum: 5,
          payload: { query: MATCHING_QUERY, limit: 10, includeArchived: false, debug: false },
        },
        {
          path: '/v1/context',
          maximum: 5,
          payload: {
            task: 'rollback release unmatchedterm',
            includeArchived: false,
            allowUnsupportedBudget: false,
          },
        },
        { path: `/v1/sources/${encodeURIComponent(fixture.knownArtifactId)}`, maximum: 4 },
        { path: '/v1/tables', maximum: 3 },
        { path: tablePath, maximum: 5 },
        { path: `${tablePath}/query`, maximum: 5, payload: { sql: fixture.sql } },
      ];
      for (const probe of probes) {
        fixture.db.resetCalls();
        const response = await fixture.request(probe.path, probe.payload);
        const body = await response.text();
        expect(response.status, `${probe.path}: ${body}`).toBe(200);
        expect.soft(fixture.db.calls.length, probe.path).toBeLessThanOrEqual(probe.maximum);
      }
    } finally {
      await fixture.close();
    }
  });

  it('does not fan out D1 queries with deeper context assembly', async () => {
    const fixture = await measuredFixture();
    try {
      fixture.db.resetCalls();
      const response = await fixture.request('/v1/context', {
        task: 'rollback release unmatchedterm',
        includeArchived: false,
        budget: 24_000,
        allowUnsupportedBudget: false,
      });
      expect(response.status).toBe(200);
      const bundle = (await response.json()) as ContextBundle;
      expect(bundle.selected.length).toBeGreaterThan(0);
      expect(fixture.db.calls.length).toBeLessThanOrEqual(5);
      expect(fixture.db.calls.filter((call) => call.query.includes('FROM chunks_fts')).length).toBe(
        2,
      );
    } finally {
      await fixture.close();
    }
  });
});
