import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { loadConfig, ProgressBus, type SearchResult } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { withTempProject } from '../../../tools/test-support/src/index.ts';
import {
  D1ActiveBuildProvider,
  type D1CatalogDatabaseLike,
  D1CatalogStore,
  type D1DatabaseLike,
  type D1QueryDatabaseLike,
  type ProjectionMigrationDatabaseLike,
} from '../src/index.js';
import { projectBuildMetadata } from '../src/project-metadata.js';
import { projectSearchData } from '../src/project-search-data.js';
import { runProjectionMigrations } from '../src/projection-migrations.js';

const CONFIG = 'version: 1\nname: parity\nsources:\n  - .\n';

const CORPUS = {
  'lore.yaml': CONFIG,
  'guides/release.md':
    '# Release\n\n## Rollback\n\nRollback restores the previous release after the release train stalls.\n',
  'notes/retro.md':
    '# Retro\n\nThe release checklist now includes rollback drills before every release.\n',
  'ops/runbook.md':
    '# Runbook\n\nRollback practice keeps the release process predictable under pressure.\n',
};

class SqliteStatement
  implements
    ProjectionMigrationDatabaseLike,
    ReturnType<D1CatalogDatabaseLike['prepare']>,
    ReturnType<D1QueryDatabaseLike['prepare']>,
    ReturnType<D1DatabaseLike['prepare']>
{
  readonly #db: DatabaseSync;
  readonly #query: string;
  #bindings: readonly unknown[] = [];

  constructor(db: DatabaseSync, query: string) {
    this.#db = db;
    this.#query = query;
  }

  bind(...values: unknown[]): SqliteStatement {
    this.#bindings = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const statement = this.#db.prepare(this.#query);
    return (statement.get(...this.#bindings) as T | undefined) ?? null;
  }

  async run<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }> {
    const statement = this.#db.prepare(this.#query);
    const trimmed = this.#query.trim().toLowerCase();
    if (trimmed.startsWith('select') || trimmed.startsWith('pragma')) {
      return { results: statement.all(...this.#bindings) as readonly T[] };
    }
    statement.run(...this.#bindings);
    return {};
  }
}

class SqliteProjectionDatabase
  implements
    ProjectionMigrationDatabaseLike,
    D1CatalogDatabaseLike,
    D1QueryDatabaseLike,
    D1DatabaseLike
{
  readonly raw: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.raw = db;
  }

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this.raw, query);
  }
}

const databases: DatabaseSync[] = [];

function trackDatabase(db: DatabaseSync): DatabaseSync {
  databases.push(db);
  return db;
}

afterEach(() => {
  while (databases.length > 0) {
    try {
      databases.pop()?.close();
    } catch {}
  }
});

function summarize(result: SearchResult): readonly string[] {
  return result.hits.map(
    (hit) => `${hit.artifactId}|${hit.chunkId}|${hit.locator.relativePath}|${hit.excerpt}`,
  );
}

describe('local versus D1 ranking parity, issue 87', () => {
  it('returns the same ordered search hits for the same projected build', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      const built = await import('../../cli/src/services/build.js').then(({ runBuild }) =>
        runBuild({ config, progress: new ProgressBus() }),
      );
      const buildDirectory = join(project.root, '.lore', 'builds', built.buildId);

      const localBackend = createLocalRuntimeBackend({ projectRoot: project.root });
      const localRuntime = createRuntime(localBackend);

      const projection = new SqliteProjectionDatabase(trackDatabase(new DatabaseSync(':memory:')));
      await runProjectionMigrations(projection, () => '2026-08-08T18:00:00.000Z');
      await projectBuildMetadata({
        db: projection,
        projectId: 'parity',
        buildDirectory,
        projectedAt: '2026-08-08T18:00:00.000Z',
      });
      await projectSearchData({
        db: projection,
        projectId: 'parity',
        buildId: built.buildId,
        buildDirectory,
      });
      projection.raw
        .prepare('UPDATE active_build SET build_id = ?, generation = ? WHERE id = 1')
        .run(built.buildId, 1);

      const remoteRuntime = createRuntime({
        provider: new D1ActiveBuildProvider(projection),
        open: async (handle) => ({
          buildId: handle.buildId,
          catalog: new D1CatalogStore({
            db: projection,
            namespace: { projectId: 'parity', buildId: handle.buildId },
          }),
          tables: {
            async list() {
              return [];
            },
            async describe() {
              return null;
            },
            async query() {
              throw new Error('table-query is outside this parity slice');
            },
          },
          objects: {
            async get() {
              return null;
            },
            async put() {
              return '';
            },
            async has() {
              return false;
            },
          },
        }),
        freshness: async () => 'clean',
      });

      try {
        for (const query of ['rollback', 'rollback release'] as const) {
          const local = await localRuntime.search({
            query,
            limit: 5,
            includeArchived: false,
            debug: false,
          });
          const remote = await remoteRuntime.search({
            query,
            limit: 5,
            includeArchived: false,
            debug: false,
          });

          expect(summarize(remote)).toEqual(summarize(local));
        }
      } finally {
        localBackend.close();
      }
    });
  });
});
