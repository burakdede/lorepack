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

type Runtime = ReturnType<typeof createRuntime>;

/**
 * Builds a corpus once and serves it twice: from the local catalog, and from the same build
 * projected into an in-memory SQLite that stands in for D1. Both run the real FTS5.
 */
async function withBothRuntimes(
  files: Readonly<Record<string, string>>,
  body: (runtimes: { readonly local: Runtime; readonly remote: Runtime }) => Promise<void>,
): Promise<void> {
  await withTempProject({ files }, async (project) => {
    const config = loadConfig({ cwd: project.root });
    const built = await import('../../cli/src/services/build.js').then(({ runBuild }) =>
      runBuild({ config, progress: new ProgressBus() }),
    );
    const buildDirectory = join(project.root, '.lore', 'builds', built.buildId);

    const localBackend = createLocalRuntimeBackend({ projectRoot: project.root });
    const local = createRuntime(localBackend);

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

    const remote = createRuntime({
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
      await body({ local, remote });
    } finally {
      localBackend.close();
    }
  });
}

async function search(runtime: Runtime, query: string, limit = 5): Promise<SearchResult> {
  return await runtime.search({ query, limit, includeArchived: false, debug: false });
}

describe('local versus D1 ranking parity, issue 87', () => {
  it('returns the same ordered search hits for the same projected build', async () => {
    await withBothRuntimes(CORPUS, async ({ local, remote }) => {
      // The last query repeats a term in three spellings the tokenizer folds together, so
      // both adapters must de-duplicate it the same way (#625).
      for (const query of ['rollback', 'rollback release', 'Rollback ROLLBACK, release.']) {
        expect(summarize(await search(remote, query))).toEqual(
          summarize(await search(local, query)),
        );
      }
    });
  });
});

/**
 * #625. A high-frequency term repeated N times made FTS5 intersect the same postings list
 * N times, and the cost grew quadratically: on an 800-file corpus twenty repeats of `a`
 * ran past a minute. One query string from any token holder tied up the local server or
 * the deployment's single D1 database.
 */
describe('repeated query terms cost what one term costs, issue 625', () => {
  const COMMON = 'a the of and to in is it that for on with as was be by this are or at'.split(' ');

  function generatedCorpus(): Record<string, string> {
    const files: Record<string, string> = { 'lore.yaml': CONFIG };
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let file = 0; file < 120; file += 1) {
      let text = `# Document ${file}\n\n`;
      for (let section = 0; section < 6; section += 1) {
        const words = Array.from(
          { length: 200 },
          () => COMMON[Math.floor(next() * next() * COMMON.length)],
        );
        text += `## Section ${section}\n\n${words.join(' ')}.\n\n`;
      }
      files[`docs/doc-${file}.md`] = text;
    }
    return files;
  }

  async function timed<T>(body: () => Promise<T>): Promise<{ result: T; ms: number }> {
    const started = performance.now();
    const result = await body();
    return { result, ms: performance.now() - started };
  }

  it('answers a repeated term like the single term, in about the same time', async () => {
    await withBothRuntimes(generatedCorpus(), async (runtimes) => {
      const repeated = [
        Array(60).fill('a').join(' '),
        // Spellings the tokenizer folds into the same token count as repeats too.
        'a A a. a, (a) "a" à á â ä ã å ā a! a? a: a; a- a/ a\\ a* a^ a[ a] a{ a} a< a>',
      ];
      for (const runtime of [runtimes.local, runtimes.remote]) {
        const baseline = await search(runtime, 'a', 10);
        let single = 0;
        for (let run = 0; run < 3; run += 1) {
          single = Math.max(single, (await timed(() => search(runtime, 'a', 10))).ms);
        }

        for (const query of repeated) {
          const { result, ms } = await timed(() => search(runtime, query, 10));
          expect(summarize(result)).toEqual(summarize(baseline));
          // Before the fix sixty repeats cost well over fifty times the single term. The
          // slack absorbs a slow CI runner without letting the quadratic case through.
          expect(ms).toBeLessThan(single * 4 + 250);
        }
      }
    });
  }, 120_000);

  it('refuses a query past the distinct-term cap on both adapters', async () => {
    await withBothRuntimes(CORPUS, async ({ local, remote }) => {
      const query = Array.from({ length: 65 }, (_, index) => `term${index}`).join(' ');
      for (const runtime of [local, remote]) {
        await expect(search(runtime, query)).rejects.toMatchObject({
          code: 'LORE_E_INVALID_ARGUMENT',
        });
      }
    });
  });
});
