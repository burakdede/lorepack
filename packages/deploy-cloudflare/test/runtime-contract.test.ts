import type {
  BuildId,
  BuildManifest,
  BuildScope,
  CatalogArtifact,
  CatalogNode,
  CatalogSearchCriteria,
  CatalogSearchHit,
  CatalogStore,
} from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { type ContractFixture, runRuntimeContract } from '../../../tools/test-support/src/index.ts';
import { D1ActiveBuildProvider, type D1DatabaseLike, D1TableStore } from '../src/index.js';
import type { D1QueryDatabaseLike } from '../src/tables.js';

const BUILD = `lore_${'a'.repeat(64)}` as BuildId;
const PROJECT = 'contracted';
const TABLE_ID = 'contracted:pricing.xlsx#Products';
const MATCHING_QUERY = 'rollback';
const ARTIFACT_ID = 'contracted:guides/rollback.md';
const OBJECT_HASH = 'f'.repeat(64);

const HIT: CatalogSearchHit = {
  chunkId: `${ARTIFACT_ID}@0`,
  artifactId: ARTIFACT_ID,
  relativePath: 'guides/rollback.md',
  displayPath: 'guides/rollback.md',
  headingPath: ['Rollback'],
  lineStart: 1,
  lineEnd: 4,
  status: 'active',
  authority: 50,
  estimatedTokens: 16,
  text: 'To roll back a release, activate the previous build.',
  title: 'Rollback',
  bm25: -2,
  excerpt: 'To [rollback] a release',
};

const ARTIFACT: CatalogArtifact = {
  artifactId: ARTIFACT_ID,
  relativePath: 'guides/rollback.md',
  displayPath: 'guides/rollback.md',
  title: 'Rollback',
  status: 'active',
  authority: 50,
  mediaType: 'text/markdown',
  objectHash: OBJECT_HASH,
};

const NODES: readonly CatalogNode[] = [
  {
    nodeId: 'n0',
    artifactId: ARTIFACT_ID,
    kind: 'paragraph',
    ordinal: 0,
    title: null,
    text: 'To roll back a release, activate the previous build.',
    headingPath: ['Rollback'],
    lineStart: 1,
    lineEnd: 2,
  },
  {
    nodeId: 'n1',
    artifactId: ARTIFACT_ID,
    kind: 'paragraph',
    ordinal: 1,
    title: null,
    text: 'Tell the team what changed after the rollback.',
    headingPath: ['Rollback'],
    lineStart: 4,
    lineEnd: 5,
  },
];

const catalog: CatalogStore = {
  async manifest(): Promise<BuildManifest> {
    return {
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
  },
  async countChunks() {
    return 1;
  },
  async countWarnings() {
    return 0;
  },
  async search(_query: string, criteria: CatalogSearchCriteria) {
    return [HIT].slice(0, criteria.limit);
  },
  async supersededArtifacts() {
    return new Set<string>();
  },
  async artifact(idOrPath: string): Promise<CatalogArtifact | null> {
    return idOrPath === ARTIFACT_ID || idOrPath === 'guides/rollback.md' ? ARTIFACT : null;
  },
  async artifacts() {
    return [
      {
        ...ARTIFACT,
        byteSize: 96,
        parserId: 'markdown',
        chunkCount: 1,
        nodeCount: 2,
      },
    ];
  },
  async nodes(artifactId: string): Promise<readonly CatalogNode[]> {
    return artifactId === ARTIFACT_ID ? NODES : [];
  },
};

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
    return (this.#db.handlers.get(this.#query)?.(this.#bindings)[0] ?? null) as T | null;
  }

  async run<T>(): Promise<{ readonly results?: readonly T[] }> {
    return {
      results: (this.#db.handlers.get(this.#query)?.(this.#bindings) ?? []) as readonly T[],
    };
  }
}

class FakeD1Database implements D1DatabaseLike, D1QueryDatabaseLike {
  readonly handlers = new Map<string, (bindings: readonly unknown[]) => readonly unknown[]>();

  prepare(query: string): FakePreparedStatement {
    return new FakePreparedStatement(this, query);
  }
}

function installTableHandlers(db: FakeD1Database): void {
  db.handlers.set('SELECT build_id AS buildId, generation FROM active_build WHERE id = 1', () => [
    { buildId: BUILD, generation: 7 },
  ]);

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

runRuntimeContract({
  name: 'Cloudflare Worker runtime fixture',
  create: async (): Promise<ContractFixture> => {
    const db = new FakeD1Database();
    installTableHandlers(db);
    const provider = new D1ActiveBuildProvider(db);
    const runtime = createRuntime({
      provider,
      open: async (handle): Promise<BuildScope> => ({
        buildId: handle.buildId,
        catalog,
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
      knownArtifactId: ARTIFACT_ID,
      matchingQuery: MATCHING_QUERY,
      knownTableId: TABLE_ID,
    };
  },
});
