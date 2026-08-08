import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Capability,
  type DeploymentTarget,
  hashBytes,
  type LoreError,
  SCHEMA_VERSION,
} from '@lorepack/core';
import {
  createCloudflareDeploymentTarget,
  createCloudflareWorkerFromBindings,
  type D1CatalogDatabaseLike,
  type D1DatabaseLike,
  type D1QueryDatabaseLike,
  type ProjectionMigrationDatabaseLike,
  type ProjectionMigrationStatementLike,
  type R2BucketLike,
} from '@lorepack/deploy-cloudflare';
import { withTempProject } from '@lorepack/test-support';
import { afterEach, describe, expect, it } from 'vitest';
import { readReceipt, runDeploy } from '../src/services/deploy.js';

const PROJECT = 'contracted';
const ACTIVE_BUILD = `lore_${'a'.repeat(64)}` as const;
const CANDIDATE_BUILD = `lore_${'b'.repeat(64)}` as const;
const ENDPOINT = 'https://example.workers.dev/mcp';
const CONFIG = 'version: 1\nname: contracted\nsources:\n  - .\n';

class FakeR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array): Promise<void> {
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

class SqliteStatement
  implements ProjectionMigrationStatementLike, ReturnType<D1DatabaseLike['prepare']>
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

class SqliteBindingsDatabase
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

function createProjection(path: string): SqliteBindingsDatabase {
  return new SqliteBindingsDatabase(
    trackDatabase(
      new DatabaseSync(path, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
      }),
    ),
  );
}

function createBuild(
  projectRoot: string,
  buildId: string,
  text: string,
  queryWord: string,
): string {
  const buildDirectory = join(projectRoot, '.lore', 'builds', buildId);
  const objectsDirectory = join(projectRoot, '.lore', 'objects');
  mkdirSync(join(buildDirectory, 'reports'), { recursive: true });
  mkdirSync(objectsDirectory, { recursive: true });

  const body = new TextEncoder().encode(text);
  const hash = hashBytes(body);
  const objectPath = join(
    objectsDirectory,
    'sha256',
    hash.slice(0, 2),
    hash.slice(2, 4),
    hash.slice(4),
  );
  mkdirSync(dirname(objectPath), { recursive: true });
  writeFileSync(objectPath, body);

  writeFileSync(
    join(buildDirectory, 'manifest.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        buildId,
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
        capabilities: ['lexical-search', 'structured-context'],
        counts: { artifacts: 1, nodes: 1, chunks: 1, tables: 0, tableRows: 0 },
        warnings: [],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(buildDirectory, 'reports', 'warnings.json'), '[]\n');

  const db = trackDatabase(
    new DatabaseSync(join(buildDirectory, 'context.sqlite'), {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    }),
  );
  db.exec(`CREATE TABLE artifacts (
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
  db.exec(`CREATE TABLE supersessions (
    artifact_id TEXT NOT NULL,
    superseded_id TEXT NOT NULL,
    PRIMARY KEY (artifact_id, superseded_id)
  ) STRICT`);
  db.exec(`CREATE TABLE nodes (
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
  db.exec(`CREATE TABLE chunks (
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
  db.exec(`CREATE TABLE tables (
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
  db.exec(`CREATE TABLE table_columns (
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

  const artifactId = `${PROJECT}:guides/${queryWord}.md`;
  db.prepare(
    `INSERT INTO artifacts
      (id, source_id, relative_path, display_path, media_type, byte_size, content_hash,
       parser_id, parser_version, title, status, authority, object_hash, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    artifactId,
    `guides/${queryWord}.md`,
    `guides/${queryWord}.md`,
    `guides/${queryWord}.md`,
    'text/markdown',
    body.byteLength,
    'e'.repeat(64),
    'markdown',
    '1.0.0',
    queryWord,
    'active',
    50,
    hash,
    '{}',
  );
  db.prepare(
    `INSERT INTO nodes
      (id, artifact_id, parent_id, kind, ordinal, title, text, heading_path, line_start, line_end, metadata, revision_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${artifactId}@n0`,
    artifactId,
    null,
    'paragraph',
    0,
    null,
    text,
    `["${queryWord}"]`,
    1,
    1,
    '{}',
    '1'.repeat(64),
  );
  db.prepare(
    `INSERT INTO chunks
      (id, artifact_id, node_ids, heading_path, text, estimated_tokens, relative_path, line_start, line_end, page, revision_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${artifactId}@c0`,
    artifactId,
    JSON.stringify([`${artifactId}@n0`]),
    `["${queryWord}"]`,
    text,
    12,
    `guides/${queryWord}.md`,
    1,
    1,
    null,
    '2'.repeat(64),
  );
  db.close();

  return buildDirectory;
}

function countingTarget(target: DeploymentTarget): {
  readonly target: DeploymentTarget;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    target: {
      id: target.id,
      detect: async () => {
        calls.push('detect');
        return target.detect();
      },
      capabilities: async () => target.capabilities(),
      plan: async (input) => {
        calls.push('plan');
        return target.plan(input);
      },
      apply: async (plan, resume, progress) => {
        calls.push('apply');
        return target.apply(plan, resume, progress);
      },
      verify: async (receipt) => {
        calls.push('verify');
        return target.verify(receipt);
      },
      activate: async (receipt) => {
        calls.push('activate');
        return target.activate(receipt);
      },
      rollback: async (buildId) => target.rollback(buildId),
    },
  };
}

async function seedActiveBuild(
  buildId: typeof ACTIVE_BUILD,
  buildDirectory: string,
  projection: SqliteBindingsDatabase,
  bucket: FakeR2Bucket,
): Promise<void> {
  const target = createCloudflareDeploymentTarget({
    projectId: PROJECT,
    endpoint: ENDPOINT,
    catalogDb: projection,
    objects: bucket,
    publicBuildId: async () => buildId,
  });
  const plan = await target.plan({
    projectName: PROJECT,
    buildId,
    buildDirectory,
    buildCapabilities: ['lexical-search', 'structured-context'] as Capability[],
  });
  const receipt = await target.apply(plan);
  await target.activate(receipt);
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

describe('Cloudflare deploy orchestration, issue 264', () => {
  it('fails a stale public health check with a resumable receipt and reuses the candidate', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      trackDirectory(temp.root);

      const activeDirectory = createBuild(
        temp.root,
        ACTIVE_BUILD,
        'activeword only appears in the active build',
        'activeword',
      );
      const candidateDirectory = createBuild(
        temp.root,
        CANDIDATE_BUILD,
        'candidateword only appears in the candidate build',
        'candidateword',
      );

      const bucket = new FakeR2Bucket();
      const targetProjection = createProjection(join(temp.root, 'target.sqlite'));
      const publicProjection = createProjection(join(temp.root, 'public.sqlite'));

      await seedActiveBuild(ACTIVE_BUILD, activeDirectory, targetProjection, bucket);
      await seedActiveBuild(ACTIVE_BUILD, activeDirectory, publicProjection, bucket);

      const staleWorker = createCloudflareWorkerFromBindings({
        CATALOG_DB: publicProjection,
        OBJECTS: bucket,
        PROJECT_ID: PROJECT,
      });

      const firstTarget = countingTarget(
        createCloudflareDeploymentTarget({
          projectId: PROJECT,
          endpoint: ENDPOINT,
          catalogDb: targetProjection,
          objects: bucket,
          publicBuildId: async () => {
            const response = await staleWorker.fetch(
              new Request('https://worker.example/v1/build'),
            );
            const payload = (await response.json()) as { buildId: string };
            return payload.buildId as typeof ACTIVE_BUILD;
          },
        }),
      );

      const firstFailure = await runDeploy({
        target: firstTarget.target,
        projectRoot: temp.root,
        projectName: PROJECT,
        buildId: CANDIDATE_BUILD,
        buildDirectory: candidateDirectory,
        buildCapabilities: ['lexical-search', 'structured-context'] as Capability[],
        progress: { start() {}, progress() {}, finish() {}, diagnostic() {} },
        now: () => new Date('2026-08-08T14:20:00.000Z'),
      }).catch((error: unknown) => error);

      expect((firstFailure as LoreError).code).toBe('LORE_E_REMOTE_DEPLOY');
      expect((firstFailure as LoreError).message).toContain(ACTIVE_BUILD);
      expect((firstFailure as LoreError).remediation).toContain(
        'projected candidate is still there',
      );
      expect(firstTarget.calls).toEqual(['detect', 'plan', 'apply', 'verify', 'activate']);

      const partial = readReceipt(temp.root, `cloudflare-${CANDIDATE_BUILD.slice(5, 17)}`);
      expect(partial.state).toBe('failed');
      expect(partial.previousBuildId).toBe(ACTIVE_BUILD);
      expect(partial.endpoint).toBe(ENDPOINT);
      expect(partial.completedSteps).toEqual(['plan', 'project', 'verify', 'activate']);

      expect(
        targetProjection.raw
          .prepare('SELECT build_id AS buildId, generation FROM active_build WHERE id = 1')
          .get(),
      ).toEqual({ buildId: CANDIDATE_BUILD, generation: 2 });

      await staleWorker.close();

      const liveWorker = createCloudflareWorkerFromBindings({
        CATALOG_DB: targetProjection,
        OBJECTS: bucket,
        PROJECT_ID: PROJECT,
      });

      const resumeTarget = countingTarget(
        createCloudflareDeploymentTarget({
          projectId: PROJECT,
          endpoint: ENDPOINT,
          catalogDb: targetProjection,
          objects: bucket,
          publicBuildId: async () => {
            const response = await liveWorker.fetch(new Request('https://worker.example/v1/build'));
            const payload = (await response.json()) as { buildId: string };
            return payload.buildId as typeof CANDIDATE_BUILD;
          },
        }),
      );

      const resumed = await runDeploy({
        target: resumeTarget.target,
        projectRoot: temp.root,
        projectName: PROJECT,
        buildId: CANDIDATE_BUILD,
        buildDirectory: candidateDirectory,
        buildCapabilities: ['lexical-search', 'structured-context'] as Capability[],
        resume: partial,
        progress: { start() {}, progress() {}, finish() {}, diagnostic() {} },
        now: () => new Date('2026-08-08T14:25:00.000Z'),
      });

      expect(resumeTarget.calls).toEqual(['detect', 'plan', 'activate']);
      expect(resumed.receipt.state).toBe('active');
      expect(resumed.receipt.completedSteps).toEqual([
        'plan',
        'project',
        'verify',
        'activate',
        'smoke',
      ]);
      expect(
        targetProjection.raw
          .prepare('SELECT build_id AS buildId, generation FROM active_build WHERE id = 1')
          .get(),
      ).toEqual({ buildId: CANDIDATE_BUILD, generation: 2 });

      await liveWorker.close();
    });
  });
});
