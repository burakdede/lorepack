import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Capability,
  type DeploymentReceipt,
  hashBytes,
  SCHEMA_VERSION,
  type VerificationResult,
} from '@lorepack/core';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudflareApplyError, createCloudflareDeploymentTarget } from '../src/index.js';
import type {
  ProjectionMigrationDatabaseLike,
  ProjectionMigrationStatementLike,
} from '../src/projection-migrations.js';
import { r2ArchiveKey, r2ObjectKey } from '../src/r2-keys.js';

const PROJECT = 'contracted';
const BUILD = `lore_${'a'.repeat(64)}` as DeploymentReceipt['buildId'];
const BUILD_B = `lore_${'b'.repeat(64)}` as DeploymentReceipt['buildId'];
const BUILD_C = `lore_${'c'.repeat(64)}` as DeploymentReceipt['buildId'];
const ENDPOINT = 'https://example.workers.dev/mcp';

class FakeR2Bucket {
  readonly objects = new Map<string, Uint8Array>();
  failOnPutPrefix: string | null = null;

  async put(key: string, value: Uint8Array): Promise<void> {
    if (this.failOnPutPrefix !== null && key.startsWith(this.failOnPutPrefix)) {
      throw new Error(`Refused put for ${key}`);
    }
    this.objects.set(key, new Uint8Array(value));
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return {
      arrayBuffer: async () =>
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer,
    };
  }

  async head(key: string): Promise<Record<string, never> | null> {
    return this.objects.has(key) ? {} : null;
  }
}

class SqliteStatement implements ProjectionMigrationStatementLike {
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

class SqliteProjectionDatabase implements ProjectionMigrationDatabaseLike {
  readonly raw: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.raw = db;
  }

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this.raw, query);
  }
}

const directories: string[] = [];
const databases: DatabaseSync[] = [];

function trackDirectory(path: string): string {
  directories.push(path);
  return path;
}

function trackDatabase(db: DatabaseSync): DatabaseSync {
  databases.push(db);
  return db;
}

function makeBuildFixture(
  input: { readonly chunkText?: string; readonly tableName?: string } = {},
): {
  readonly buildDirectory: string;
  readonly projection: SqliteProjectionDatabase;
  readonly bucket: FakeR2Bucket;
  readonly objectHashes: readonly string[];
} {
  const root = trackDirectory(mkdtempSync(join(tmpdir(), 'lore-cloudflare-target-')));
  const loreDirectory = join(root, '.lore');
  const buildDirectory = join(loreDirectory, 'builds', BUILD);
  const objectsDirectory = join(loreDirectory, 'objects');

  mkdirSync(join(buildDirectory, 'reports'), { recursive: true });
  mkdirSync(objectsDirectory, { recursive: true });

  writeFileSync(
    join(buildDirectory, 'manifest.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        buildId: BUILD,
        projectName: PROJECT,
        compilerVersion: '0.1.0',
        schemaVersion: SCHEMA_VERSION,
        configurationHash: 'c'.repeat(64),
        sourceFingerprint: 'd'.repeat(64),
        canonicalRoots: {
          artifacts: '1'.repeat(64),
          nodes: '2'.repeat(64),
          chunks: '3'.repeat(64),
          tables: '4'.repeat(64),
          objects: '5'.repeat(64),
        },
        capabilities: ['lexical-search', 'structured-context', 'table-query'],
        counts: { artifacts: 2, nodes: 1, chunks: 1, tables: 1, tableRows: 1 },
        warnings: [],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(buildDirectory, 'reports', 'warnings.json'), '[]\n');

  const chunkText = input.chunkText ?? 'Activate the previous build to roll back.';
  const tableName = input.tableName ?? 'Basic';
  const bodyA = new TextEncoder().encode('rollback body');
  const bodyB = new TextEncoder().encode('pricing body');
  const hashA = hashBytes(bodyA);
  const hashB = hashBytes(bodyB);

  for (const [hash, body] of [
    [hashA, bodyA],
    [hashB, bodyB],
  ] as const) {
    const path = join(
      objectsDirectory,
      'sha256',
      hash.slice(0, 2),
      hash.slice(2, 4),
      hash.slice(4),
    );
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }

  const buildDb = new DatabaseSync(join(buildDirectory, 'context.sqlite'), {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  buildDb.exec(`CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    display_path TEXT NOT NULL,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    parser_id TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL,
    authority INTEGER NOT NULL,
    object_hash TEXT NOT NULL,
    metadata TEXT NOT NULL
  ) STRICT`);
  buildDb.exec(`CREATE TABLE supersessions (
    artifact_id TEXT NOT NULL,
    superseded_id TEXT NOT NULL,
    PRIMARY KEY (artifact_id, superseded_id)
  ) STRICT`);
  buildDb.exec(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    parent_id TEXT,
    kind TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    title TEXT,
    text TEXT,
    heading_path TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER,
    metadata TEXT NOT NULL,
    revision_hash TEXT NOT NULL
  ) STRICT`);
  buildDb.exec(`CREATE TABLE chunks (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    node_ids TEXT NOT NULL,
    heading_path TEXT NOT NULL,
    text TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER,
    page INTEGER,
    revision_hash TEXT NOT NULL
  ) STRICT`);
  buildDb.exec(`CREATE TABLE tables (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sheet TEXT,
    sql_name TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER,
    cell_range TEXT,
    metadata TEXT NOT NULL
  ) STRICT`);
  buildDb.exec(`CREATE TABLE table_columns (
    table_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    sql_name TEXT NOT NULL,
    type TEXT NOT NULL,
    nullable INTEGER NOT NULL,
    null_count INTEGER NOT NULL,
    distinct_estimate INTEGER NOT NULL,
    distinct_is_exact INTEGER NOT NULL,
    min_value TEXT,
    max_value TEXT,
    PRIMARY KEY (table_id, ordinal)
  ) STRICT`);
  buildDb.exec(`CREATE TABLE products (
    name TEXT NOT NULL,
    price INTEGER NOT NULL
  ) STRICT`);

  buildDb
    .prepare(
      `INSERT INTO artifacts
      (id, source_id, relative_path, display_path, media_type, byte_size, content_hash,
       parser_id, parser_version, title, status, authority, object_hash, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'contracted:guides/rollback.md',
      'guides/rollback.md',
      'guides/rollback.md',
      'guides/rollback.md',
      'text/markdown',
      bodyA.byteLength,
      'e'.repeat(64),
      'markdown',
      '1.0.0',
      'Rollback',
      'active',
      50,
      hashA,
      '{}',
    );
  buildDb
    .prepare(
      `INSERT INTO artifacts
      (id, source_id, relative_path, display_path, media_type, byte_size, content_hash,
       parser_id, parser_version, title, status, authority, object_hash, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'contracted:pricing.xlsx',
      'pricing.xlsx',
      'pricing.xlsx',
      'pricing.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bodyB.byteLength,
      'f'.repeat(64),
      'xlsx',
      '1.0.0',
      'Pricing',
      'active',
      50,
      hashB,
      '{}',
    );
  buildDb
    .prepare(
      `INSERT INTO nodes
      (id, artifact_id, parent_id, kind, ordinal, title, text, heading_path, line_start, line_end, metadata, revision_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'n0',
      'contracted:guides/rollback.md',
      null,
      'paragraph',
      0,
      null,
      chunkText,
      '["Rollback"]',
      3,
      3,
      '{}',
      '1'.repeat(64),
    );
  buildDb
    .prepare(
      `INSERT INTO chunks
      (id, artifact_id, node_ids, heading_path, text, estimated_tokens, relative_path, line_start, line_end, page, revision_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'contracted:guides/rollback.md@0',
      'contracted:guides/rollback.md',
      '["n0"]',
      '["Rollback"]',
      chunkText,
      12,
      'guides/rollback.md',
      3,
      3,
      null,
      '2'.repeat(64),
    );
  buildDb
    .prepare(
      `INSERT INTO tables
      (id, artifact_id, name, sheet, sql_name, row_count, relative_path, line_start, line_end, cell_range, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'contracted:pricing.xlsx#Products',
      'contracted:pricing.xlsx',
      'Products',
      'Products',
      'products',
      1,
      'pricing.xlsx',
      1,
      2,
      'A1:B2',
      '{}',
    );
  buildDb
    .prepare(
      `INSERT INTO table_columns
      (table_id, ordinal, name, sql_name, type, nullable, null_count, distinct_estimate, distinct_is_exact, min_value, max_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'contracted:pricing.xlsx#Products',
      0,
      'Name',
      'name',
      'text',
      0,
      0,
      1,
      1,
      tableName,
      tableName,
    );
  buildDb
    .prepare(
      `INSERT INTO table_columns
      (table_id, ordinal, name, sql_name, type, nullable, null_count, distinct_estimate, distinct_is_exact, min_value, max_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('contracted:pricing.xlsx#Products', 1, 'Price', 'price', 'integer', 0, 0, 1, 1, '5', '5');
  buildDb.prepare('INSERT INTO products (name, price) VALUES (?, ?)').run(tableName, 5);
  buildDb.close();

  const projectionDb = trackDatabase(new DatabaseSync(':memory:'));
  return {
    buildDirectory,
    projection: new SqliteProjectionDatabase(projectionDb),
    bucket: new FakeR2Bucket(),
    objectHashes: [hashA, hashB],
  };
}

afterEach(() => {
  while (databases.length > 0) {
    try {
      databases.pop()?.close();
    } catch {}
  }
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

describe('createCloudflareDeploymentTarget, issue 263', () => {
  it('plans and applies a candidate projection with archive and object transfer state', async () => {
    const fixture = makeBuildFixture();
    const target = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
      now: () => '2026-08-08T13:55:00.000Z',
      rollbackBuild: async () => ({
        buildId: BUILD,
        previousBuildId: null,
        confirmedBuildId: BUILD,
        endpoint: ENDPOINT,
      }),
    });

    const plan = await target.plan({
      projectName: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });
    expect(plan.transfer?.archive?.key).toBe(r2ArchiveKey(PROJECT, BUILD));
    expect(plan.transfer?.objects?.referenced).toBe(2);

    const receipt = await target.apply(plan);

    expect(receipt.transfer?.state).toMatchObject({
      migrations_done: true,
      metadata_done: true,
      search_done: true,
      tables_done: true,
      archive_done: true,
      objects_done: true,
    });
    expect(receipt.transfer?.objects).toEqual({
      referenced: 2,
      uploaded: 2,
      skipped: 0,
      verified: 2,
    });
    expect(fixture.bucket.objects.has(r2ArchiveKey(PROJECT, BUILD))).toBe(true);
    expect(
      fixture.bucket.objects.has(r2ObjectKey(PROJECT, fixture.objectHashes[0] as string)),
    ).toBe(true);
    expect(
      fixture.projection.raw.prepare('SELECT build_id FROM active_build WHERE id = 1').get(),
    ).toEqual({ build_id: null });
  });

  it('skips archive and object uploads when the candidate payload is already present', async () => {
    const fixture = makeBuildFixture();
    const firstTarget = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
    });
    const secondTarget = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
    });

    const firstPlan = await firstTarget.plan({
      projectName: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });
    await firstTarget.apply(firstPlan);

    const secondPlan = await secondTarget.plan({
      projectName: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });
    const secondReceipt = await secondTarget.apply(secondPlan);

    expect(secondReceipt.transfer?.archive).toMatchObject({
      key: r2ArchiveKey(PROJECT, BUILD),
    });
    expect(secondReceipt.transfer?.objects).toEqual({
      referenced: 2,
      uploaded: 0,
      skipped: 2,
      verified: 2,
    });
    expect(secondReceipt.transfer?.state).toMatchObject({
      migrations_done: true,
      metadata_done: true,
      search_done: true,
      tables_done: true,
      archive_done: true,
      objects_done: true,
    });
  });

  it('reports projection steps and upload bytes while applying', async () => {
    const fixture = makeBuildFixture();
    const target = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
    });

    const plan = await target.plan({
      projectName: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });
    const updates: Array<{
      stage: string;
      completed: number;
      total?: number;
      unit?: string;
      detail?: string;
    }> = [];

    await target.apply(plan, undefined, (update) => {
      updates.push(update);
    });

    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'projecting',
          completed: 1,
          total: 4,
          unit: 'steps',
          detail: 'migrations',
        }),
        expect.objectContaining({
          stage: 'uploading',
          unit: 'bytes',
        }),
      ]),
    );
    expect(
      updates.some(
        (update) =>
          update.stage === 'projecting' &&
          update.unit === 'batches' &&
          update.detail?.startsWith('metadata: ') === true &&
          typeof update.completed === 'number' &&
          typeof update.total === 'number' &&
          update.completed <= update.total,
      ),
    ).toBe(true);
    expect(
      updates.some(
        (update) =>
          update.stage === 'projecting' &&
          update.unit === 'batches' &&
          update.detail?.startsWith('search: ') === true &&
          typeof update.completed === 'number' &&
          typeof update.total === 'number' &&
          update.completed <= update.total,
      ),
    ).toBe(true);
    expect(
      updates.some(
        (update) =>
          update.stage === 'projecting' &&
          update.unit === 'batches' &&
          update.detail?.startsWith('tables: ') === true &&
          typeof update.completed === 'number' &&
          typeof update.total === 'number' &&
          update.completed <= update.total,
      ),
    ).toBe(true);
    expect(
      updates.some(
        (update) =>
          update.stage === 'uploading' &&
          update.detail?.includes('objects') === true &&
          typeof update.completed === 'number' &&
          typeof update.total === 'number' &&
          update.completed <= update.total,
      ),
    ).toBe(true);
  });

  it('renders resolved resource, projection, and activation facts in the plan', async () => {
    const fixture = makeBuildFixture();
    const previousDirectory = join(dirname(fixture.buildDirectory), BUILD_B);
    cpSync(fixture.buildDirectory, previousDirectory, { recursive: true });
    writeFileSync(
      join(previousDirectory, 'manifest.json'),
      readFileSync(join(previousDirectory, 'manifest.json'), 'utf8').replaceAll(BUILD, BUILD_B),
    );
    const previousDb = new DatabaseSync(join(previousDirectory, 'context.sqlite'), {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    previousDb
      .prepare('UPDATE artifacts SET content_hash = ? WHERE id = ?')
      .run('9'.repeat(64), 'contracted:pricing.xlsx');
    previousDb.close();

    const previousTarget = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      workerName: 'contracted-runtime',
      catalogDatabaseName: 'contracted-catalog',
      objectsBucketName: 'contracted-objects',
      catalogDb: fixture.projection,
      objects: fixture.bucket,
      publicBuildId: async () => BUILD_B,
    });
    const previousPlan = await previousTarget.plan({
      projectName: PROJECT,
      buildId: BUILD_B,
      buildDirectory: previousDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });
    const previousReceipt = await previousTarget.apply(previousPlan);
    await previousTarget.activate(previousReceipt);

    const target = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      workerName: 'contracted-runtime',
      catalogDatabaseName: 'contracted-catalog',
      objectsBucketName: 'contracted-objects',
      catalogDb: fixture.projection,
      objects: fixture.bucket,
      publicBuildId: async () => BUILD_B,
    });

    const plan = await target.plan({
      projectName: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });

    expect(plan.display).toEqual({
      targetLabel: 'cloudflare / personal',
      resourceLines: [
        '= Worker contracted-runtime',
        '= D1 contracted-catalog',
        '= R2 contracted-objects',
      ],
      projectionLines: [
        '+ 0 artifacts',
        '~ 1 artifact',
        '= 1 artifact reused by content hash',
        '+ 1 chunk',
        '+ 1 table row',
        '~ about 47 projected D1 bytes',
      ],
      activationLines: [`current ${BUILD_B}`, `next    ${BUILD}`],
    });
  });

  it('warns when the projected D1 size approaches the free-tier limit and names the largest contributors', async () => {
    const fixture = makeBuildFixture();
    const target = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      workerName: 'contracted-runtime',
      catalogDatabaseName: 'contracted-catalog',
      objectsBucketName: 'contracted-objects',
      catalogDb: fixture.projection,
      objects: fixture.bucket,
      preflight: () => ({
        estimatedProjectedBytes: 451_000_000,
        largestContributors: [
          { relativePath: 'pricing.xlsx', bytes: 300_000_000 },
          { relativePath: 'guides/rollback.md', bytes: 120_000_000 },
          { relativePath: 'appendix.md', bytes: 31_000_000 },
        ],
      }),
    });

    const plan = await target.plan({
      projectName: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });

    expect(plan.display?.projectionLines).toEqual([
      '+ 2 artifacts',
      '~ 0 artifacts',
      '= 0 artifacts reused by content hash',
      '+ 1 chunk',
      '+ 1 table row',
      '~ about 451,000,000 projected D1 bytes',
      "! approaches Cloudflare D1's free-tier 500,000,000 byte limit",
      '! pricing.xlsx: about 300,000,000 bytes',
      '! guides/rollback.md: about 120,000,000 bytes',
      '! appendix.md: about 31,000,000 bytes',
    ]);
  });

  it('refuses plan-time projection when one chunk text is above the D1 value limit', async () => {
    const fixture = makeBuildFixture({ chunkText: 'x'.repeat(2_000_001) });
    const target = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
    });

    const failure = await target
      .plan({
        projectName: PROJECT,
        buildId: BUILD,
        buildDirectory: fixture.buildDirectory,
        buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'LORE_E_LIMIT_EXCEEDED',
      subject: 'guides/rollback.md',
    });
    expect((failure as Error).message).toContain("Cloudflare D1's 2,000,000-byte value limit");
    expect(
      fixture.projection.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projected_builds'",
        )
        .get(),
    ).toBeUndefined();
  });

  it('refuses plan-time projection when one table row is above the D1 row limit', async () => {
    const fixture = makeBuildFixture({ tableName: 'x'.repeat(2_000_001) });
    const target = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
    });

    const failure = await target
      .plan({
        projectName: PROJECT,
        buildId: BUILD,
        buildDirectory: fixture.buildDirectory,
        buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'LORE_E_LIMIT_EXCEEDED',
      subject: 'pricing.xlsx',
    });
    expect((failure as Error).message).toContain("Cloudflare D1's 2,000,000-byte row limit");
    expect(
      fixture.projection.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projected_builds'",
        )
        .get(),
    ).toBeUndefined();
  });

  it('verifies the candidate through the projected runtime and records capabilities', async () => {
    const fixture = makeBuildFixture();
    const target = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
      publicBuildId: async () => BUILD,
    });

    const plan = await target.plan({
      projectName: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });
    const receipt = await target.apply(plan);
    const verification = await target.verify(receipt);

    expect(verification).toEqual({
      search: 'passed',
      sourceRead: 'passed',
      tableQuery: 'passed',
      capabilities: ['lexical-search', 'structured-context', 'table-query'],
    } satisfies VerificationResult);
  });

  it('activates atomically by switching the pointer and incrementing generation', async () => {
    const fixture = makeBuildFixture();
    const target = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
      publicBuildId: async () => BUILD,
    });

    const plan = await target.plan({
      projectName: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });
    const receipt = await target.apply(plan);
    fixture.projection.raw
      .prepare('UPDATE active_build SET build_id = ?, generation = ? WHERE id = 1')
      .run(`lore_${'b'.repeat(64)}`, 7);
    const activation = await target.activate(receipt);

    expect(activation).toEqual({
      buildId: BUILD,
      previousBuildId: `lore_${'b'.repeat(64)}`,
      confirmedBuildId: BUILD,
      endpoint: ENDPOINT,
    });
    expect(
      fixture.projection.raw
        .prepare('SELECT build_id, generation FROM active_build WHERE id = 1')
        .get(),
    ).toEqual({ build_id: BUILD, generation: 8 });
  });

  it('rolls back to a previously projected build by pointer change alone', async () => {
    const fixture = makeBuildFixture();
    const previousDirectory = join(dirname(fixture.buildDirectory), BUILD_B);
    cpSync(fixture.buildDirectory, previousDirectory, { recursive: true });
    writeFileSync(
      join(previousDirectory, 'manifest.json'),
      readFileSync(join(previousDirectory, 'manifest.json'), 'utf8').replaceAll(BUILD, BUILD_B),
    );

    const target = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
      publicBuildId: async () => BUILD_B,
    });

    const previousPlan = await target.plan({
      projectName: PROJECT,
      buildId: BUILD_B,
      buildDirectory: previousDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });
    await target.apply(previousPlan);

    const currentPlan = await target.plan({
      projectName: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });
    const currentReceipt = await target.apply(currentPlan);
    await target.activate(currentReceipt);

    const activation = await target.rollback(BUILD_B);

    expect(activation).toEqual({
      buildId: BUILD_B,
      previousBuildId: BUILD,
      confirmedBuildId: BUILD_B,
      endpoint: ENDPOINT,
    });
    expect(
      fixture.projection.raw
        .prepare('SELECT build_id, generation FROM active_build WHERE id = 1')
        .get(),
    ).toEqual({ build_id: BUILD_B, generation: 2 });
  });

  it('refuses to roll back to an incomplete projection and leaves activation unchanged', async () => {
    const fixture = makeBuildFixture();
    const target = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
    });

    const currentPlan = await target.plan({
      projectName: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });
    const currentReceipt = await target.apply(currentPlan);
    await target.activate(currentReceipt);

    const failure = await target.rollback(BUILD_B).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).toBe('LORE_E_BUILD_NOT_FOUND');
    expect(
      fixture.projection.raw
        .prepare('SELECT build_id, generation FROM active_build WHERE id = 1')
        .get(),
    ).toEqual({ build_id: BUILD, generation: 1 });
  });

  it('fails one contender cleanly when activation attempts race for the lock', async () => {
    const fixture = makeBuildFixture();
    const root = dirname(dirname(dirname(fixture.buildDirectory)));
    const secondDirectory = join(dirname(fixture.buildDirectory), BUILD_B);
    cpSync(fixture.buildDirectory, secondDirectory, { recursive: true });
    writeFileSync(
      join(secondDirectory, 'manifest.json'),
      readFileSync(join(secondDirectory, 'manifest.json'), 'utf8').replace(BUILD, BUILD_B),
    );

    const projectionPath = join(root, 'projection.sqlite');
    const firstProjection = new SqliteProjectionDatabase(
      trackDatabase(new DatabaseSync(projectionPath)),
    );
    const secondProjection = new SqliteProjectionDatabase(
      trackDatabase(new DatabaseSync(projectionPath)),
    );
    const firstTarget = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: firstProjection,
      objects: fixture.bucket,
      publicBuildId: async () => null,
    });
    const secondTarget = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: secondProjection,
      objects: fixture.bucket,
      publicBuildId: async () => null,
    });

    const firstPlan = await firstTarget.plan({
      projectName: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });
    const secondPlan = await secondTarget.plan({
      projectName: PROJECT,
      buildId: BUILD_B,
      buildDirectory: secondDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });
    const firstReceipt = await firstTarget.apply(firstPlan);
    const secondReceipt = await secondTarget.apply(secondPlan);

    firstProjection.raw
      .prepare('UPDATE active_build SET build_id = ?, generation = ? WHERE id = 1')
      .run(BUILD_C, 7);

    const settled = await Promise.allSettled([
      firstTarget.activate(firstReceipt),
      secondTarget.activate(secondReceipt),
    ]);

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const failure = settled.find((result) => result.status === 'rejected');
    expect(failure?.status).toBe('rejected');
    expect((failure as PromiseRejectedResult).reason).toMatchObject({
      code: 'LORE_E_REMOTE_DEPLOY',
    });

    expect(
      firstProjection.raw
        .prepare('SELECT build_id, generation FROM active_build WHERE id = 1')
        .get(),
    ).toEqual({
      build_id: expect.stringMatching(/^lore_[ab]{64}$/),
      generation: 8,
    });
  });

  it('resumes from transfer state without re-uploading the archive', async () => {
    const fixture = makeBuildFixture();
    const target = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
    });

    const plan = await target.plan({
      projectName: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });
    const first = await target.apply(plan);
    const second = await target.apply(plan, {
      ...first,
      transfer: {
        ...first.transfer,
        objects: {
          referenced: 2,
          uploaded: 0,
          skipped: 0,
          verified: 0,
        },
        state: {
          ...(first.transfer?.state ?? {}),
          objects_done: false,
        },
      },
    });

    expect(second.transfer?.objects).toEqual({
      referenced: 2,
      uploaded: 0,
      skipped: 2,
      verified: 2,
    });
    expect(second.transfer?.archive).toEqual(first.transfer?.archive);
  });

  it('throws a partial receipt when apply fails after earlier candidate work completed', async () => {
    const fixture = makeBuildFixture();
    fixture.bucket.failOnPutPrefix = `${PROJECT}/objects/`;
    const target = createCloudflareDeploymentTarget({
      projectId: PROJECT,
      endpoint: ENDPOINT,
      catalogDb: fixture.projection,
      objects: fixture.bucket,
    });

    const plan = await target.plan({
      projectName: PROJECT,
      buildId: BUILD,
      buildDirectory: fixture.buildDirectory,
      buildCapabilities: ['lexical-search', 'structured-context', 'table-query'] as Capability[],
    });

    try {
      await target.apply(plan);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareApplyError);
      expect((error as CloudflareApplyError).receipt.transfer?.state).toMatchObject({
        migrations_done: true,
        metadata_done: true,
        search_done: true,
        tables_done: true,
        archive_done: true,
        objects_done: false,
      });
    }
  });
});
