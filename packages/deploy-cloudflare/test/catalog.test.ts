import type { BuildManifest } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import { type D1CatalogDatabaseLike, D1CatalogStore } from '../src/catalog.js';

const PROJECT = 'contracted';
const BUILD = `lore_${'a'.repeat(64)}`;

class FakePreparedStatement {
  readonly #db: FakeD1Database;
  readonly #query: string;
  readonly #bindings: readonly unknown[];

  constructor(db: FakeD1Database, query: string, bindings: readonly unknown[] = []) {
    this.#db = db;
    this.#query = query;
    this.#bindings = bindings;
  }

  bind(...values: unknown[]): FakePreparedStatement {
    return new FakePreparedStatement(this.#db, this.#query, values);
  }

  async run<T>(): Promise<{ readonly results?: readonly T[] }> {
    this.#db.calls.push({ query: this.#query, bindings: [...this.#bindings] });
    return {
      results: (this.#db.handlers.get(this.#query)?.(this.#bindings) ?? []) as readonly T[],
    };
  }
}

class FakeD1Database implements D1CatalogDatabaseLike {
  readonly calls: Array<{ query: string; bindings: unknown[] }> = [];
  readonly handlers = new Map<string, (bindings: readonly unknown[]) => readonly unknown[]>();

  prepare(query: string): FakePreparedStatement {
    return new FakePreparedStatement(this, query);
  }
}

const MANIFEST: BuildManifest = {
  formatVersion: 1,
  buildId: BUILD,
  projectName: PROJECT,
  compilerVersion: '0.1.0',
  schemaVersion: 1,
  configurationHash: 'c'.repeat(64),
  sourceFingerprint: 'd'.repeat(64),
  canonicalRoots: {
    artifacts: '1'.repeat(64),
    nodes: '2'.repeat(64),
    chunks: '3'.repeat(64),
    tables: '4'.repeat(64),
    objects: '5'.repeat(64),
  },
  capabilities: ['lexical-search', 'structured-context', 'typed-tables'],
  counts: { artifacts: 2, nodes: 3, chunks: 2, tables: 1, tableRows: 3 },
  warnings: [],
};

function installHandlers(db: FakeD1Database): void {
  db.handlers.set(
    `SELECT count(*) AS count
FROM chunks
WHERE project_id = ? AND build_id = ?`,
    ([projectId, buildId]) => (projectId === PROJECT && buildId === BUILD ? [{ count: 2 }] : []),
  );

  db.handlers.set(
    `SELECT count(*) AS count
FROM build_warnings
WHERE project_id = ? AND build_id = ?`,
    ([projectId, buildId]) => (projectId === PROJECT && buildId === BUILD ? [{ count: 1 }] : []),
  );

  db.handlers.set(
    `SELECT a.id, a.relative_path AS relativePath, a.display_path AS displayPath, a.title,
       a.status, a.authority, a.media_type AS mediaType, a.object_hash AS objectHash,
       a.byte_size AS byteSize, a.parser_id AS parserId,
       (SELECT count(*) FROM chunks c
         WHERE c.project_id = a.project_id AND c.build_id = a.build_id AND c.artifact_id = a.id) AS chunkCount,
       (SELECT count(*) FROM nodes n
         WHERE n.project_id = a.project_id AND n.build_id = a.build_id AND n.artifact_id = a.id) AS nodeCount
FROM artifacts a
WHERE a.project_id = ? AND a.build_id = ?
ORDER BY a.relative_path`,
    ([projectId, buildId]) =>
      projectId === PROJECT && buildId === BUILD
        ? [
            {
              id: 'contracted:guides/rollback.md',
              relativePath: 'guides/rollback.md',
              displayPath: 'guides/rollback.md',
              title: 'Rollback',
              status: 'active',
              authority: 50,
              mediaType: 'text/markdown',
              objectHash: 'f'.repeat(64),
              byteSize: 96,
              parserId: 'markdown',
              chunkCount: 2,
              nodeCount: 3,
            },
          ]
        : [],
  );

  db.handlers.set(
    `SELECT id, relative_path AS relativePath, display_path AS displayPath, title,
       status, authority, media_type AS mediaType, object_hash AS objectHash
FROM artifacts
WHERE project_id = ? AND build_id = ? AND (id = ? OR relative_path = ?)
LIMIT 1`,
    ([projectId, buildId, wantedId, wantedPath]) =>
      projectId === PROJECT &&
      buildId === BUILD &&
      (wantedId === 'contracted:guides/rollback.md' || wantedPath === 'guides/rollback.md')
        ? [
            {
              id: 'contracted:guides/rollback.md',
              relativePath: 'guides/rollback.md',
              displayPath: 'guides/rollback.md',
              title: 'Rollback',
              status: 'active',
              authority: 50,
              mediaType: 'text/markdown',
              objectHash: 'f'.repeat(64),
            },
          ]
        : [],
  );

  db.handlers.set(
    `SELECT id, artifact_id AS artifactId, kind, ordinal, title, text,
       heading_path AS headingPath, line_start AS lineStart, line_end AS lineEnd
FROM nodes
WHERE project_id = ? AND build_id = ? AND artifact_id = ?
ORDER BY ordinal`,
    ([projectId, buildId, artifactId]) =>
      projectId === PROJECT && buildId === BUILD && artifactId === 'contracted:guides/rollback.md'
        ? [
            {
              id: 'n0',
              artifactId: 'contracted:guides/rollback.md',
              kind: 'paragraph',
              ordinal: 0,
              title: null,
              text: 'To roll back a release, activate the previous build.',
              headingPath: '["Rollback"]',
              lineStart: 1,
              lineEnd: 2,
            },
          ]
        : [],
  );

  db.handlers.set(
    `SELECT superseded_id AS supersededId
FROM supersessions
WHERE project_id = ? AND build_id = ?`,
    ([projectId, buildId]) =>
      projectId === PROJECT && buildId === BUILD ? [{ supersededId: 'contracted:old.md' }] : [],
  );

  db.handlers.set(
    `SELECT c.id AS chunkId,
              c.artifact_id AS artifactId,
              c.relative_path AS relativePath,
              a.display_path AS displayPath,
              c.heading_path AS headingPath,
              c.text AS text,
              c.line_start AS lineStart,
              c.line_end AS lineEnd,
              c.page AS page,
              a.status AS status,
              a.authority AS authority,
              c.estimated_tokens AS estimatedTokens,
              a.title AS title,
              snippet(chunks_fts, 9, '[', ']', ' ... ', 20) AS excerpt,
              bm25(chunks_fts, 10.0, 4.0, 6.0, 1.0) AS bm25
         FROM chunks_fts f
         JOIN chunks c
           ON c.id = f.chunk_id AND c.project_id = f.project_id AND c.build_id = f.build_id
         JOIN artifacts a
           ON a.id = c.artifact_id AND a.project_id = c.project_id AND a.build_id = c.build_id
        WHERE f.project_id = ? AND f.build_id = ? AND c.project_id = ? AND c.build_id = ? AND a.project_id = ? AND a.build_id = ? AND chunks_fts MATCH ?
        ORDER BY bm25
        LIMIT ?`,
    (bindings) =>
      bindings[0] === PROJECT && bindings[1] === BUILD && bindings[6] === '"rollback"'
        ? [
            {
              chunkId: 'contracted:guides/rollback.md@0',
              artifactId: 'contracted:guides/rollback.md',
              relativePath: 'guides/rollback.md',
              displayPath: 'guides/rollback.md',
              headingPath: '["Rollback"]',
              text: 'To roll back a release, activate the previous build.',
              excerpt: 'To [rollback] a release',
              page: null,
              lineStart: 1,
              lineEnd: 2,
              status: 'active',
              authority: 50,
              estimatedTokens: 16,
              title: 'Rollback',
              bm25: -2,
            },
          ]
        : [],
  );
}

describe('D1CatalogStore', () => {
  it('reads manifest from the injected provider', async () => {
    const db = new FakeD1Database();
    const store = new D1CatalogStore({
      db,
      namespace: { projectId: PROJECT, buildId: BUILD },
      manifest: async () => MANIFEST,
    });

    expect(await store.manifest()).toEqual(MANIFEST);
  });

  it('binds project and build namespace in count and lookup queries', async () => {
    const db = new FakeD1Database();
    installHandlers(db);
    const store = new D1CatalogStore({
      db,
      namespace: { projectId: PROJECT, buildId: BUILD },
      manifest: async () => MANIFEST,
    });

    expect(await store.countChunks()).toBe(2);
    expect(await store.countWarnings()).toBe(1);
    expect(await store.artifact('guides/rollback.md')).toEqual({
      artifactId: 'contracted:guides/rollback.md',
      relativePath: 'guides/rollback.md',
      displayPath: 'guides/rollback.md',
      title: 'Rollback',
      status: 'active',
      authority: 50,
      mediaType: 'text/markdown',
      objectHash: 'f'.repeat(64),
    });
    expect(db.calls[0]?.bindings).toEqual([PROJECT, BUILD]);
    expect(db.calls[1]?.bindings).toEqual([PROJECT, BUILD]);
    expect(db.calls[2]?.bindings).toEqual([
      PROJECT,
      BUILD,
      'guides/rollback.md',
      'guides/rollback.md',
    ]);
  });

  it('returns namespaced nodes and superseded artifact ids', async () => {
    const db = new FakeD1Database();
    installHandlers(db);
    const store = new D1CatalogStore({
      db,
      namespace: { projectId: PROJECT, buildId: BUILD },
      manifest: async () => MANIFEST,
    });

    expect(await store.nodes('contracted:guides/rollback.md')).toEqual([
      {
        nodeId: 'n0',
        artifactId: 'contracted:guides/rollback.md',
        kind: 'paragraph',
        ordinal: 0,
        title: null,
        text: 'To roll back a release, activate the previous build.',
        headingPath: ['Rollback'],
        lineStart: 1,
        lineEnd: 2,
      },
    ]);
    expect(await store.supersededArtifacts()).toEqual(new Set(['contracted:old.md']));
  });

  it('searches through the namespaced FTS projection', async () => {
    const db = new FakeD1Database();
    installHandlers(db);
    const store = new D1CatalogStore({
      db,
      namespace: { projectId: PROJECT, buildId: BUILD },
      manifest: async () => MANIFEST,
    });

    const hits = await store.search('rollback', { limit: 10 });

    expect(hits).toEqual([
      {
        chunkId: 'contracted:guides/rollback.md@0',
        artifactId: 'contracted:guides/rollback.md',
        relativePath: 'guides/rollback.md',
        displayPath: 'guides/rollback.md',
        headingPath: ['Rollback'],
        text: 'To roll back a release, activate the previous build.',
        excerpt: 'To [rollback] a release',
        page: null,
        lineStart: 1,
        lineEnd: 2,
        status: 'active',
        authority: 50,
        estimatedTokens: 16,
        title: 'Rollback',
        bm25: -2,
      },
    ]);
    expect(db.calls.at(-1)?.bindings).toEqual([
      PROJECT,
      BUILD,
      PROJECT,
      BUILD,
      PROJECT,
      BUILD,
      '"rollback"',
      10,
    ]);
  });
});
