import { describe, expect, it } from 'vitest';
import { D1ActiveBuildProvider } from '../src/storage.js';
import {
  ACTIVE_BUILD,
  activateProjectedWorkerRuntimeFixture,
  CANDIDATE_BUILD,
  createProjectedWorkerRuntimeFixture,
  PROJECT,
} from './projected-runtime-fixture.js';

describe('exact selection over retained projection state, issue432', () => {
  it('keeps text, contexts and typed rows on A after B activates', async () => {
    const fixture = await createProjectedWorkerRuntimeFixture();
    try {
      await activateProjectedWorkerRuntimeFixture();
      const selection = { buildId: ACTIVE_BUILD };
      for (let index = 0; index < 200; index += 1) {
        const bundle = await fixture.runtime.contextForTask({
          task: fixture.matchingQuery,
          includeArchived: false,
          allowUnsupportedBudget: false,
          ...selection,
        });
        expect(bundle.buildId).toBe(ACTIVE_BUILD);
        expect(JSON.stringify(bundle)).not.toContain('tell the team what changed');
      }
      const search = await fixture.runtime.search({
        query: fixture.matchingQuery,
        limit: 5,
        includeArchived: false,
        debug: false,
        ...selection,
      });
      expect(search.hits.length).toBeGreaterThan(0);
      expect(search.buildId).toBe(ACTIVE_BUILD);
      const source = await fixture.runtime.readSource({
        artifactId: fixture.knownArtifactId,
        ...selection,
      });
      expect(source.buildId).toBe(ACTIVE_BUILD);
      expect(source.text).not.toContain('tell the team what changed');
      const described = await fixture.runtime.describeTable(fixture.knownTableId, selection);
      const query = await fixture.runtime.queryTable({
        tableId: fixture.knownTableId,
        sql: `SELECT ${described.columns.map((column) => column.sqlName).join(', ')} FROM ${described.sqlName}`,
        ...selection,
      });
      expect(query.buildId).toBe(ACTIVE_BUILD);
      expect(query.rows[0]).toMatchObject({ 'List Price': 19.99 });
      expect((await fixture.runtime.listTables(selection)).tables.length).toBeGreaterThan(0);
    } finally {
      await fixture.close();
    }
  });
  it('selects A after B activates and preserves owned runtime identity', async () => {
    const fixture = await createProjectedWorkerRuntimeFixture();
    try {
      const first = await fixture.runtime.describeBuild();
      expect(await activateProjectedWorkerRuntimeFixture()).toBe(CANDIDATE_BUILD);
      const selected = await fixture.runtime.describeBuild({ buildId: ACTIVE_BUILD });
      expect(selected.buildId).toBe(ACTIVE_BUILD);
      expect(selected.corpusId).toBe(first.corpusId);
      expect(selected.namespaceId).toBe(first.namespaceId);
      expect((await fixture.runtime.describeBuild()).buildId).toBe(CANDIDATE_BUILD);
      const provider = new D1ActiveBuildProvider(fixture.projection, PROJECT);
      const handle = await provider.acquire({ buildId: ACTIVE_BUILD });
      try {
        provider.assertHandle(handle);
        expect(handle.buildId).toBe(ACTIVE_BUILD);
      } finally {
        handle.release();
      }
    } finally {
      await fixture.close();
    }
  });

  it('refuses a projected candidate that has not passed verification', async () => {
    const fixture = await createProjectedWorkerRuntimeFixture();
    try {
      await expect(
        fixture.runtime.describeBuild({ buildId: CANDIDATE_BUILD }),
      ).rejects.toMatchObject({ code: 'LORE_E_BUILD_NOT_FOUND' });
      expect((await fixture.runtime.describeBuild()).buildId).toBe(ACTIVE_BUILD);
    } finally {
      await fixture.close();
    }
  });

  it('refuses a removed selected projection without falling back to B', async () => {
    const fixture = await createProjectedWorkerRuntimeFixture();
    try {
      await activateProjectedWorkerRuntimeFixture();
      fixture.projection.raw
        .prepare('DELETE FROM projected_builds WHERE project_id = ? AND build_id = ?')
        .run(PROJECT, ACTIVE_BUILD);
      await expect(fixture.runtime.describeBuild({ buildId: ACTIVE_BUILD })).rejects.toMatchObject({
        code: 'LORE_E_BUILD_NOT_FOUND',
      });
      expect((await fixture.runtime.describeBuild()).buildId).toBe(CANDIDATE_BUILD);
    } finally {
      await fixture.close();
    }
  });

  it('reads verified A without an active pointer', async () => {
    const fixture = await createProjectedWorkerRuntimeFixture();
    try {
      fixture.projection.raw.exec('UPDATE active_build SET build_id = NULL');
      expect((await fixture.runtime.describeBuild({ buildId: ACTIVE_BUILD })).buildId).toBe(
        ACTIVE_BUILD,
      );
      await expect(fixture.runtime.describeBuild()).rejects.toMatchObject({
        code: 'LORE_E_BUILD_NOT_FOUND',
      });
    } finally {
      await fixture.close();
    }
  });
});
