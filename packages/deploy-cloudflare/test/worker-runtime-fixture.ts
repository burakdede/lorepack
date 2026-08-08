import type { BuildId, BuildManifest, BuildScope, LoreRuntime } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import {
  D1ActiveBuildProvider,
  type D1CatalogDatabaseLike,
  type D1CatalogNamespace,
  D1CatalogStore,
  type D1DatabaseLike,
  D1TableStore,
} from '../src/index.js';
import type { D1QueryDatabaseLike } from '../src/tables.js';

export const BUILD = `lore_${'a'.repeat(64)}` as BuildId;
export const PROJECT = 'contracted';
export const TABLE_ID = 'contracted:pricing.xlsx#Products';
export const MATCHING_QUERY = 'rollback';
export const ARTIFACT_ID = 'contracted:guides/rollback.md';
export const OBJECT_HASH = 'f'.repeat(64);

const MANIFEST: BuildManifest = {
  formatVersion: 1,
  buildId: BUILD,
  projectName: PROJECT,
  compilerVersion: '0.1.0',
  schemaVersion: 1,
  configurationHash: 'c'.repeat(64),
  sourceFingerprint: 'd'.repeat(64),
  canonicalRoots: {
    artifacts: 'e'.repeat(64),
    nodes: '1'.repeat(64),
    chunks: '2'.repeat(64),
    tables: '3'.repeat(64),
    objects: '4'.repeat(64),
  },
  capabilities: ['lexical-search', 'structured-context', 'typed-tables'],
  counts: { artifacts: 1, nodes: 2, chunks: 1, tables: 1, tableRows: 3 },
  warnings: [],
} as BuildManifest;

interface SearchFixtureOptions {
  readonly fallbackHitCount?: number;
}

export interface QueryCall {
  readonly query: string;
  readonly bindings: readonly unknown[];
  readonly method: 'first' | 'run';
}

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

  async first<T>(): Promise<T | null> {
    this.#db.calls.push({ query: this.#query, bindings: [...this.#bindings], method: 'first' });
    return (this.#db.handlers.get(this.#query)?.(this.#bindings)[0] ?? null) as T | null;
  }

  async run<T>(): Promise<{ readonly results?: readonly T[] }> {
    this.#db.calls.push({ query: this.#query, bindings: [...this.#bindings], method: 'run' });
    return {
      results: (this.#db.handlers.get(this.#query)?.(this.#bindings) ?? []) as readonly T[],
    };
  }
}

export class FakeD1Database implements D1DatabaseLike, D1QueryDatabaseLike, D1CatalogDatabaseLike {
  readonly handlers = new Map<string, (bindings: readonly unknown[]) => readonly unknown[]>();
  readonly calls: QueryCall[] = [];

  prepare(query: string): FakePreparedStatement {
    return new FakePreparedStatement(this, query);
  }

  resetCalls(): void {
    this.calls.length = 0;
  }
}

const namespace = (): D1CatalogNamespace => ({ projectId: PROJECT, buildId: BUILD });

function searchRows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    chunkId: `${ARTIFACT_ID}@${String(index)}`,
    artifactId: ARTIFACT_ID,
    relativePath: 'guides/rollback.md',
    displayPath: 'guides/rollback.md',
    headingPath: '["Rollback"]',
    text: `Rollback note ${String(index + 1)}`,
    excerpt: `Rollback [note] ${String(index + 1)}`,
    page: null,
    lineStart: 1,
    lineEnd: 2,
    status: 'active',
    authority: 50,
    estimatedTokens: 16,
    title: 'Rollback',
    bm25: -2 - index,
  }));
}

function installHandlers(db: FakeD1Database, options: SearchFixtureOptions): void {
  const fallbackHitCount = options.fallbackHitCount ?? 1;

  db.handlers.set('SELECT build_id AS buildId, generation FROM active_build WHERE id = 1', () => [
    { buildId: BUILD, generation: 7 },
  ]);

  db.handlers.set(
    `SELECT count(*) AS count
FROM chunks
WHERE project_id = ? AND build_id = ?`,
    ([projectId, buildId]) => (projectId === PROJECT && buildId === BUILD ? [{ count: 1 }] : []),
  );

  db.handlers.set(
    `SELECT count(*) AS count
FROM build_warnings
WHERE project_id = ? AND build_id = ?`,
    ([projectId, buildId]) => (projectId === PROJECT && buildId === BUILD ? [{ count: 0 }] : []),
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
              id: ARTIFACT_ID,
              relativePath: 'guides/rollback.md',
              displayPath: 'guides/rollback.md',
              title: 'Rollback',
              status: 'active',
              authority: 50,
              mediaType: 'text/markdown',
              objectHash: OBJECT_HASH,
              byteSize: 96,
              parserId: 'markdown',
              chunkCount: 1,
              nodeCount: 2,
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
      (wantedId === ARTIFACT_ID || wantedPath === 'guides/rollback.md')
        ? [
            {
              id: ARTIFACT_ID,
              relativePath: 'guides/rollback.md',
              displayPath: 'guides/rollback.md',
              title: 'Rollback',
              status: 'active',
              authority: 50,
              mediaType: 'text/markdown',
              objectHash: OBJECT_HASH,
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
      projectId === PROJECT && buildId === BUILD && artifactId === ARTIFACT_ID
        ? [
            {
              id: 'n0',
              artifactId: ARTIFACT_ID,
              kind: 'paragraph',
              ordinal: 0,
              title: null,
              text: 'To roll back a release, activate the previous build.',
              headingPath: '["Rollback"]',
              lineStart: 1,
              lineEnd: 2,
            },
            {
              id: 'n1',
              artifactId: ARTIFACT_ID,
              kind: 'paragraph',
              ordinal: 1,
              title: null,
              text: 'Tell the team what changed after the rollback.',
              headingPath: '["Rollback"]',
              lineStart: 4,
              lineEnd: 5,
            },
          ]
        : [],
  );

  db.handlers.set(
    `SELECT superseded_id AS supersededId
FROM supersessions
WHERE project_id = ? AND build_id = ?`,
    ([projectId, buildId]) =>
      projectId === PROJECT && buildId === BUILD
        ? [{ supersededId: 'contracted:archived.md' }]
        : [],
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
    (bindings) => {
      if (bindings[0] !== PROJECT || bindings[1] !== BUILD) return [];
      if (bindings[6] === '"rollback"') return searchRows(1);
      if (bindings[6] === '"rollback" "release"') return [];
      if (bindings[6] === '"rollback" OR "release"') return searchRows(fallbackHitCount);
      return [];
    },
  );

  db.handlers.set(
    `SELECT id, name
FROM tables
WHERE project_id = ? AND build_id = ?
ORDER BY name, id`,
    ([projectId, buildId]) =>
      projectId === PROJECT && buildId === BUILD ? [{ id: TABLE_ID, name: 'Products' }] : [],
  );

  db.handlers.set(
    `SELECT id, artifact_id, name, sheet, sql_name, row_count,
       relative_path, line_start, line_end, cell_range
FROM tables
WHERE project_id = ? AND build_id = ? AND id = ?
LIMIT 1`,
    ([projectId, buildId, tableId]) =>
      projectId === PROJECT && buildId === BUILD && tableId === TABLE_ID
        ? [
            {
              id: TABLE_ID,
              artifact_id: 'contracted:pricing.xlsx',
              name: 'Products',
              sheet: 'Products',
              sql_name: 't_products_active',
              row_count: 3,
              relative_path: 'pricing.xlsx',
              line_start: null,
              line_end: null,
              cell_range: 'A1:C4',
            },
          ]
        : [],
  );

  db.handlers.set(
    `SELECT name, sql_name, type, nullable, null_count,
       distinct_estimate, distinct_is_exact, min_value, max_value
FROM table_columns
WHERE project_id = ? AND build_id = ? AND table_id = ?
ORDER BY ordinal`,
    ([projectId, buildId, tableId]) =>
      projectId === PROJECT && buildId === BUILD && tableId === TABLE_ID
        ? [
            {
              name: 'SKU',
              sql_name: 'c_0_sku',
              type: 'text',
              nullable: 0,
              null_count: 0,
              distinct_estimate: 3,
              distinct_is_exact: 1,
              min_value: 'A-1',
              max_value: 'A-3',
            },
            {
              name: 'List Price',
              sql_name: 'c_1_list_price',
              type: 'real',
              nullable: 1,
              null_count: 1,
              distinct_estimate: 2,
              distinct_is_exact: 1,
              min_value: '4.5',
              max_value: '19.99',
            },
            {
              name: 'Available',
              sql_name: 'c_2_available',
              type: 'boolean',
              nullable: 0,
              null_count: 0,
              distinct_estimate: 2,
              distinct_is_exact: 1,
              min_value: 'false',
              max_value: 'true',
            },
          ]
        : [],
  );

  db.handlers.set(
    'SELECT c_0_sku, c_1_list_price, c_2_available FROM t_products_active LIMIT ?',
    ([limit]) =>
      [
        { c_0_sku: 'A-1', c_1_list_price: 19.99, c_2_available: 1 },
        { c_0_sku: 'A-2', c_1_list_price: 4.5, c_2_available: 1 },
        { c_0_sku: 'A-3', c_1_list_price: null, c_2_available: 0 },
      ].slice(0, Number(limit)),
  );

  db.handlers.set('SELECT c_0_sku, c_1_list_price, c_2_available FROM t_products_active', () => [
    { c_0_sku: 'A-1', c_1_list_price: 19.99, c_2_available: 1 },
    { c_0_sku: 'A-2', c_1_list_price: 4.5, c_2_available: 1 },
    { c_0_sku: 'A-3', c_1_list_price: null, c_2_available: 0 },
  ]);

  db.handlers.set('SELECT c_0_sku FROM t_products_active', () => [
    { c_0_sku: 'A-1' },
    { c_0_sku: 'A-2' },
    { c_0_sku: 'A-3' },
  ]);
}

export interface WorkerRuntimeFixture {
  readonly runtime: LoreRuntime;
  readonly db: FakeD1Database;
  readonly knownArtifactId: string;
  readonly matchingQuery: string;
  readonly knownTableId: string;
}

export function createWorkerRuntimeFixture(
  options: SearchFixtureOptions = {},
): WorkerRuntimeFixture {
  const db = new FakeD1Database();
  installHandlers(db, options);
  const provider = new D1ActiveBuildProvider(db);
  const runtime = createRuntime({
    provider,
    open: async (handle): Promise<BuildScope> => ({
      buildId: handle.buildId,
      catalog: new D1CatalogStore({
        db,
        namespace: namespace(),
        manifest: async () => MANIFEST,
      }),
      tables: new D1TableStore(db, { projectId: PROJECT, buildId: handle.buildId }),
      objects: {
        async get(hash: string) {
          return hash === OBJECT_HASH
            ? new TextEncoder().encode(
                '# Rollback\n\nTo roll back a release, activate the previous build.\n\nTell the team what changed after the rollback.\n',
              )
            : null;
        },
        async put() {
          return '';
        },
        async has(hash: string) {
          return hash === OBJECT_HASH;
        },
      },
    }),
    freshness: async () => 'clean',
  });

  return {
    runtime,
    db,
    knownArtifactId: ARTIFACT_ID,
    matchingQuery: MATCHING_QUERY,
    knownTableId: TABLE_ID,
  };
}
