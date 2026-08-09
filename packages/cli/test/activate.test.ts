import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type BuildId, type DeploymentTarget, loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { rollbackCommand } from '../src/commands/activate.js';
import { pruneCommand } from '../src/commands/prune.js';
import { runBuild } from '../src/services/build.js';
import type { CloudflareResolverAdapter } from '../src/services/cloudflare-target.js';
import { readActiveBuild } from '../src/services/project.js';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

async function project<T>(
  files: Record<string, string>,
  body: (root: string, lore: (args: string[]) => ReturnType<typeof run>) => Promise<T>,
): Promise<T> {
  return withTempProject({ files: { 'lore.yaml': CONFIG, ...files } }, async (temp) =>
    body(temp.root, (args) => run(['--cwd', temp.root, ...args])),
  );
}

function build(root: string) {
  return runBuild({ config: loadConfig({ cwd: root }), progress: new ProgressBus() });
}

/** Three builds, oldest first. Each edit produces a distinct content-derived id. */
async function threeBuilds(
  root: string,
): Promise<{ first: string; second: string; third: string }> {
  const first = await build(root);
  writeFileSync(join(root, 'a.md'), '# A\n\nSecond text.', 'utf8');
  const second = await build(root);
  writeFileSync(join(root, 'a.md'), '# A\n\nThird text.', 'utf8');
  const third = await build(root);
  return { first: first.buildId, second: second.buildId, third: third.buildId };
}

function active(root: string): string | null {
  return readActiveBuild(join(root, '.lore'))?.buildId ?? null;
}

function fakeRemoteRollbackTarget(
  calls: string[] = [],
  buildId: BuildId = `lore_${'b'.repeat(64)}` as BuildId,
): DeploymentTarget {
  return {
    id: 'cloudflare',
    detect: async () => {
      calls.push('detect');
      return { installed: true, version: '1.0.0' };
    },
    capabilities: async () => ({ supported: ['lexical-search', 'structured-context'] }),
    plan: async () => {
      throw new Error('rollback tests do not call plan');
    },
    apply: async () => {
      throw new Error('rollback tests do not call apply');
    },
    verify: async () => {
      throw new Error('rollback tests do not call verify');
    },
    activate: async () => {
      throw new Error('rollback tests do not call activate');
    },
    rollback: async (requestedBuildId) => {
      calls.push(`rollback:${requestedBuildId}`);
      return {
        buildId: requestedBuildId,
        previousBuildId: buildId,
        confirmedBuildId: requestedBuildId,
        endpoint: 'https://example.workers.dev/mcp',
      };
    },
  };
}

class SqliteStatement {
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

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const rows = await this.run<T>();
    return (rows.results?.[0] as T | undefined) ?? null;
  }
}

class SqliteCloudflareDatabase {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this.#db, query);
  }
}

function writeCloudflareReceipt(root: string): void {
  mkdirSync(join(root, '.lore', 'targets'), { recursive: true });
  writeFileSync(
    join(root, '.lore', 'targets', 'cloudflare.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        target: 'cloudflare',
        project: 'demo',
        configuredAt: '2026-08-09T12:00:00.000Z',
        wranglerVersion: '4.119.0',
        accountId: 'acct_123',
        workerName: 'demo-runtime',
        catalogDatabaseName: 'demo-catalog',
        objectsBucketName: 'demo-objects',
        capabilities: ['lexical-search', 'structured-context', 'table-query'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

interface FakeCloudflareObjectsBucket {
  readonly deletedKeys: string[];
  seed(key: string, value?: Uint8Array): void;
}

function createFakeCloudflareObjectsBucket(): CloudflareResolverAdapter['openObjectsBucket'] extends (
  ...args: never[]
) => infer T
  ? T & FakeCloudflareObjectsBucket
  : never {
  const objects = new Map<string, Uint8Array>();
  const deletedKeys: string[] = [];
  return {
    deletedKeys,
    seed(key: string, value: Uint8Array = new Uint8Array([1])) {
      objects.set(key, value);
    },
    async put(key: string, value: Uint8Array) {
      objects.set(key, value);
    },
    async get(key: string) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return {
        arrayBuffer: async () =>
          value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer,
      };
    },
    async head(key: string) {
      return objects.has(key) ? {} : null;
    },
    async delete(key: string) {
      if (!objects.has(key)) return;
      objects.delete(key);
      deletedKeys.push(key);
    },
  };
}

function fakeCloudflareRollbackAdapter(
  db: DatabaseSync,
  objectsBucket = createFakeCloudflareObjectsBucket(),
): CloudflareResolverAdapter {
  const catalog = new SqliteCloudflareDatabase(db);
  return {
    detect: async () => ({ installed: true, version: '4.119.0', path: '/tmp/wrangler.js' }),
    whoami: async () => ({
      authenticated: true,
      email: 'dev@example.com',
      accountId: 'acct_123',
      accountName: 'Example',
    }),
    listDatabases: async () => [{ name: 'demo-catalog' }],
    openCatalogDatabase: () => catalog,
    openObjectsBucket: () => objectsBucket,
  };
}

function seedRemoteCleanupFixture(
  db: DatabaseSync,
  objects = createFakeCloudflareObjectsBucket(),
): {
  readonly db: DatabaseSync;
  readonly objects: FakeCloudflareObjectsBucket;
  readonly archiveKey: string;
  readonly objectKey: string;
} {
  db.exec(`
    CREATE TABLE active_build (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      build_id TEXT,
      generation INTEGER NOT NULL
    );
    INSERT INTO active_build (id, build_id, generation)
    VALUES (1, 'lore_${'b'.repeat(64)}', 4);
    CREATE TABLE projected_builds (
      project_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      build_schema_version INTEGER NOT NULL,
      compiler_version TEXT NOT NULL,
      projection_schema_version INTEGER NOT NULL,
      projected_at TEXT NOT NULL,
      verified_at TEXT,
      activated_at TEXT,
      PRIMARY KEY (project_id, build_id)
    );
    CREATE TABLE build_manifests (
      project_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      PRIMARY KEY (project_id, build_id)
    );
    CREATE TABLE build_warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      code TEXT NOT NULL,
      class TEXT NOT NULL,
      path TEXT,
      message TEXT NOT NULL
    );
    CREATE TABLE artifacts (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      source_id TEXT,
      relative_path TEXT NOT NULL,
      display_path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      byte_size INTEGER,
      content_hash TEXT,
      parser_id TEXT,
      parser_version TEXT,
      title TEXT,
      status TEXT NOT NULL,
      authority INTEGER NOT NULL,
      object_hash TEXT NOT NULL,
      metadata_json TEXT,
      PRIMARY KEY (project_id, build_id, id)
    );
    CREATE TABLE supersessions (
      project_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      superseded_id TEXT NOT NULL,
      PRIMARY KEY (project_id, build_id, artifact_id, superseded_id)
    );
    CREATE TABLE nodes (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      parent_id TEXT,
      kind TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      title TEXT,
      text TEXT,
      heading_path TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      metadata_json TEXT,
      revision_hash TEXT,
      PRIMARY KEY (project_id, build_id, id)
    );
    CREATE TABLE chunks (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      node_ids TEXT NOT NULL,
      heading_path TEXT NOT NULL,
      text TEXT NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      page INTEGER,
      revision_hash TEXT,
      PRIMARY KEY (project_id, build_id, id)
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      project_id UNINDEXED,
      build_id UNINDEXED,
      chunk_id UNINDEXED,
      artifact_id UNINDEXED,
      status,
      authority,
      path,
      title,
      heading,
      body
    );
    CREATE TABLE tables (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sheet TEXT,
      sql_name TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      cell_range TEXT,
      metadata_json TEXT,
      PRIMARY KEY (project_id, build_id, id)
    );
    CREATE TABLE table_columns (
      project_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
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
      PRIMARY KEY (project_id, build_id, table_id, ordinal)
    );
    INSERT INTO projected_builds
      (project_id, build_id, build_schema_version, compiler_version, projection_schema_version, projected_at, verified_at, activated_at)
    VALUES
      ('demo', 'lore_${'c'.repeat(64)}', 1, '0.1.0', 4, '2026-08-09T12:02:00.000Z', NULL, NULL),
      ('demo', 'lore_${'b'.repeat(64)}', 1, '0.1.0', 4, '2026-08-09T12:01:00.000Z', '2026-08-09T12:01:30.000Z', '2026-08-09T12:01:30.000Z'),
      ('demo', 'lore_${'a'.repeat(64)}', 1, '0.1.0', 4, '2026-08-09T12:00:00.000Z', '2026-08-09T12:00:30.000Z', '2026-08-09T12:00:30.000Z');
    INSERT INTO build_manifests (project_id, build_id, manifest_json)
    VALUES ('demo', 'lore_${'c'.repeat(64)}', '{"build":"remove"}');
    INSERT INTO build_warnings (project_id, build_id, code, class, path, message)
    VALUES ('demo', 'lore_${'c'.repeat(64)}', 'warn', 'parser', 'remove.md', 'warning');
    INSERT INTO artifacts
      (id, project_id, build_id, source_id, relative_path, display_path, media_type, byte_size, content_hash, parser_id, parser_version, title, status, authority, object_hash, metadata_json)
    VALUES
      ('remove-artifact', 'demo', 'lore_${'c'.repeat(64)}', 'remove.md', 'remove.md', 'remove.md', 'text/markdown', 10, '${'3'.repeat(64)}', 'markdown', '1.0.0', 'Remove unique', 'active', 50, '${'unique'.padEnd(64, 'u')}', '{}'),
      ('keep-artifact', 'demo', 'lore_${'a'.repeat(64)}', 'keep.md', 'keep.md', 'keep.md', 'text/markdown', 10, '${'1'.repeat(64)}', 'markdown', '1.0.0', 'Keep', 'active', 50, '${'shared'.padEnd(64, 's')}', '{}');
    INSERT INTO supersessions (project_id, build_id, artifact_id, superseded_id)
    VALUES ('demo', 'lore_${'c'.repeat(64)}', 'remove-artifact', 'older');
    INSERT INTO nodes
      (id, project_id, build_id, artifact_id, parent_id, kind, ordinal, title, text, heading_path, line_start, line_end, metadata_json, revision_hash)
    VALUES ('node-remove', 'demo', 'lore_${'c'.repeat(64)}', 'remove-artifact', NULL, 'paragraph', 0, 'Title', 'Body', '[]', 1, 1, '{}', '${'r'.repeat(64)}');
    INSERT INTO chunks
      (id, project_id, build_id, artifact_id, node_ids, heading_path, text, estimated_tokens, relative_path, line_start, line_end, page, revision_hash)
    VALUES ('chunk-remove', 'demo', 'lore_${'c'.repeat(64)}', 'remove-artifact', '["node-remove"]', '[]', 'Body', 3, 'remove.md', 1, 1, NULL, '${'r'.repeat(64)}');
    INSERT INTO chunks_fts
      (project_id, build_id, chunk_id, artifact_id, status, authority, path, title, heading, body)
    VALUES ('demo', 'lore_${'c'.repeat(64)}', 'chunk-remove', 'remove-artifact', 'active', '50', 'remove.md', 'Remove unique', 'Heading', 'Body');
    INSERT INTO tables
      (id, project_id, build_id, artifact_id, name, sheet, sql_name, row_count, relative_path, line_start, line_end, cell_range, metadata_json)
    VALUES ('table-remove', 'demo', 'lore_${'c'.repeat(64)}', 'remove-artifact', 'Budget', 'Sheet1', 'projected_demo_remove', 1, 'remove.csv', 1, 2, 'A1:B2', '{}');
    INSERT INTO table_columns
      (project_id, build_id, table_id, ordinal, name, sql_name, type, nullable, null_count, distinct_estimate, distinct_is_exact, min_value, max_value)
    VALUES ('demo', 'lore_${'c'.repeat(64)}', 'table-remove', 0, 'amount', 'amount', 'TEXT', 0, 0, 1, 1, '1', '1');
    CREATE TABLE projected_demo_remove (amount TEXT NOT NULL);
  `);

  const archiveKey = `demo/builds/lore_${'c'.repeat(64)}/archive.lorepack`;
  const objectKey = `demo/objects/sha256/${'unique'.padEnd(64, 'u').slice(0, 2)}/${'unique'.padEnd(64, 'u').slice(2, 4)}/${'unique'.padEnd(64, 'u').slice(4)}`;
  objects.seed(archiveKey);
  objects.seed(objectKey);
  return { db, objects, archiveKey, objectKey };
}

describe('lore builds', () => {
  it('lists history newest first with an active marker and counts', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { third } = await threeBuilds(root);
      const result = await lore(['builds']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('* active');
      const lines = result.stdout.split('\n').filter((line) => line.includes('lore_'));
      expect(lines).toHaveLength(3);
      expect(lines[0]?.startsWith('*')).toBe(true);
      expect(lines[0]).toContain(third.slice(0, 17));
    });
  });

  it('reports history as JSON', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { third } = await threeBuilds(root);
      const parsed = JSON.parse((await lore(['--json', 'builds'])).stdout);
      expect(parsed.activeBuildId).toBe(third);
      expect(parsed.builds).toHaveLength(3);
      expect(parsed.builds[0].counts.chunks).toBeGreaterThan(0);
    });
  });

  it('fails with an actionable message in a project that has no builds', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (_root, lore) => {
      const result = await lore(['builds']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('lore build');
    });
  });
});

describe('lore activate', () => {
  it('accepts a full id and moves the pointer', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first, third } = await threeBuilds(root);
      expect(active(root)).toBe(third);

      const result = await lore(['activate', first]);
      expect(result.code).toBe(0);
      expect(active(root)).toBe(first);
    });
  });

  it('accepts an unambiguous prefix', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first } = await threeBuilds(root);
      const result = await lore(['activate', first.slice(0, 15)]);
      expect(result.code).toBe(0);
      expect(active(root)).toBe(first);
    });
  });

  it('refuses an ambiguous prefix and lists the candidates', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first, second } = await threeBuilds(root);
      const before = active(root);

      // "lore_" alone matches every build.
      const result = await lore(['activate', 'lore_']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('matches 3 builds');
      expect(result.stderr).toContain(first);
      expect(result.stderr).toContain(second);
      expect(active(root)).toBe(before);
    });
  });

  it('leaves the pointer alone when the build is unknown', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { third } = await threeBuilds(root);
      const result = await lore(['activate', 'lore_ffffffff']);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('LORE_E_BUILD_NOT_FOUND');
      expect(active(root)).toBe(third);
    });
  });

  it('fails pre-flight on a corrupt build without touching the pointer', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first, third } = await threeBuilds(root);
      writeFileSync(join(root, '.lore', 'builds', first, 'context.sqlite'), 'not a database');

      const result = await lore(['activate', first]);
      expect(result.code).not.toBe(0);
      expect(active(root)).toBe(third);
    });
  });

  it('fails when the build is recorded but its files are gone', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first, third } = await threeBuilds(root);
      rmSync(join(root, '.lore', 'builds', first), { recursive: true, force: true });

      const result = await lore(['activate', first]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('files are missing');
      expect(active(root)).toBe(third);
    });
  });

  it('says so and changes nothing when the build is already active', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { third } = await threeBuilds(root);
      const before = JSON.parse((await lore(['--json', 'activate', third])).stdout);
      expect(before.changed).toBe(false);
    });
  });
});

describe('lore rollback', () => {
  it('returns to the previous verified build with no argument', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { second, third } = await threeBuilds(root);
      expect(active(root)).toBe(third);

      const result = await lore(['rollback']);
      expect(result.code).toBe(0);
      expect(active(root)).toBe(second);
    });
  });

  it('activates a named build when given one', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first } = await threeBuilds(root);
      await lore(['rollback', first]);
      expect(active(root)).toBe(first);
    });
  });

  it('performs no parsing, proven by deleting every source first', async () => {
    // Section 18.7: rollback never recompiles. If it did, it would fail exactly when it is
    // needed most, which is when the sources that produced the old build are gone.
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { second } = await threeBuilds(root);
      rmSync(join(root, 'a.md'));

      const started = performance.now();
      const result = await lore(['rollback']);
      const elapsed = performance.now() - started;

      expect(result.code).toBe(0);
      expect(active(root)).toBe(second);
      expect(elapsed).toBeLessThan(1000);
    });
  });

  it('increases the generation monotonically across activate, rollback and activate', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const { first, third } = await threeBuilds(root);

      const one = JSON.parse((await lore(['--json', 'activate', first])).stdout);
      const two = JSON.parse((await lore(['--json', 'rollback', third])).stdout);
      const three = JSON.parse((await lore(['--json', 'activate', first])).stdout);

      expect(two.generation).toBeGreaterThan(one.generation);
      expect(three.generation).toBeGreaterThan(two.generation);
    });
  });

  it('says there is nothing to return to when only one build exists', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await build(root);
      const result = await lore(['rollback']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('no earlier verified build');
    });
  });

  it('rolls back a remote target to a named build id', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const calls: string[] = [];
      const buildId = `lore_${'b'.repeat(64)}` as BuildId;
      const result = await run(
        ['--cwd', temp.root, 'rollback', '--target', 'cloudflare', buildId],
        {
          commands: [
            rollbackCommand({
              resolveTarget: async () =>
                fakeRemoteRollbackTarget(calls, `lore_${'a'.repeat(64)}` as BuildId),
            }),
          ],
        },
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Rolled back cloudflare to ${buildId}.`);
      expect(result.stdout).toContain('Endpoint: https://example.workers.dev/mcp');
      expect(calls).toEqual([`rollback:${buildId}`]);
    });
  });

  it('fails clearly when a remote rollback has no target receipt yet', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'rollback', '--target', 'cloudflare'], {
        commands: [
          rollbackCommand({
            resolveTarget: async () => fakeRemoteRollbackTarget(),
          }),
        ],
      });

      expect(result.code).toBe(5);
      expect(result.stderr).toContain('LORE_E_TARGET_NOT_CONFIGURED');
      expect(result.stderr).toContain('Run `lore target add cloudflare` first.');
    });
  });

  it('rolls back a remote target to the previous verified build when no id is given', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const db = new DatabaseSync(':memory:');
      writeCloudflareReceipt(temp.root);

      db.exec(`
        CREATE TABLE active_build (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          build_id TEXT,
          generation INTEGER NOT NULL
        );
        INSERT INTO active_build (id, build_id, generation)
        VALUES (1, 'lore_${'b'.repeat(64)}', 4);
        CREATE TABLE projected_builds (
          project_id TEXT NOT NULL,
          build_id TEXT NOT NULL,
          build_schema_version INTEGER NOT NULL,
          compiler_version TEXT NOT NULL,
          projection_schema_version INTEGER NOT NULL,
          projected_at TEXT NOT NULL,
          verified_at TEXT,
          activated_at TEXT,
          PRIMARY KEY (project_id, build_id)
        );
        INSERT INTO projected_builds
          (project_id, build_id, build_schema_version, compiler_version, projection_schema_version, projected_at, verified_at, activated_at)
        VALUES
          ('demo', 'lore_${'a'.repeat(64)}', 1, '0.1.0', 1, '2026-08-09T11:58:00.000Z', NULL, NULL),
          ('demo', 'lore_${'b'.repeat(64)}', 1, '0.1.0', 1, '2026-08-09T11:59:00.000Z', '2026-08-09T11:59:30.000Z', '2026-08-09T11:59:45.000Z'),
          ('demo', 'lore_${'c'.repeat(64)}', 1, '0.1.0', 1, '2026-08-09T12:00:00.000Z', '2026-08-09T12:00:30.000Z', '2026-08-09T12:00:45.000Z');
      `);
      db.prepare('UPDATE active_build SET build_id = ?, generation = ? WHERE id = 1').run(
        `lore_${'c'.repeat(64)}`,
        4,
      );

      const calls: string[] = [];
      const result = await run(['--cwd', temp.root, 'rollback', '--target', 'cloudflare'], {
        commands: [
          rollbackCommand({
            cloudflareAdapter: fakeCloudflareRollbackAdapter(db),
            resolveTarget: async () => fakeRemoteRollbackTarget(calls),
          }),
        ],
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Rolled back cloudflare to lore_${'b'.repeat(64)}.`);
      expect(calls).toEqual([`rollback:lore_${'b'.repeat(64)}`]);
      db.close();
    });
  });

  it('fails clearly when a remote target has no earlier verified build', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const db = new DatabaseSync(':memory:');
      writeCloudflareReceipt(temp.root);

      db.exec(`
        CREATE TABLE active_build (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          build_id TEXT,
          generation INTEGER NOT NULL
        );
        INSERT INTO active_build (id, build_id, generation)
        VALUES (1, 'lore_${'b'.repeat(64)}', 4);
        CREATE TABLE projected_builds (
          project_id TEXT NOT NULL,
          build_id TEXT NOT NULL,
          build_schema_version INTEGER NOT NULL,
          compiler_version TEXT NOT NULL,
          projection_schema_version INTEGER NOT NULL,
          projected_at TEXT NOT NULL,
          verified_at TEXT,
          activated_at TEXT,
          PRIMARY KEY (project_id, build_id)
        );
        INSERT INTO projected_builds
          (project_id, build_id, build_schema_version, compiler_version, projection_schema_version, projected_at, verified_at, activated_at)
        VALUES
          ('demo', 'lore_${'a'.repeat(64)}', 1, '0.1.0', 1, '2026-08-09T11:59:00.000Z', NULL, NULL),
          ('demo', 'lore_${'b'.repeat(64)}', 1, '0.1.0', 1, '2026-08-09T12:00:00.000Z', '2026-08-09T12:00:30.000Z', '2026-08-09T12:00:45.000Z');
      `);

      const result = await run(['--cwd', temp.root, 'rollback', '--target', 'cloudflare'], {
        commands: [
          rollbackCommand({
            cloudflareAdapter: fakeCloudflareRollbackAdapter(db),
            resolveTarget: async () => fakeRemoteRollbackTarget(),
          }),
        ],
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('LORE_E_BUILD_NOT_FOUND');
      expect(result.stderr).toContain('There is no earlier verified remote build to return to.');
      db.close();
    });
  });

  it('does not depend on local sources when rolling back a remote target', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'a.md': '# A\n\nText.' } },
      async (temp) => {
        rmSync(join(temp.root, 'a.md'));
        const calls: string[] = [];
        const buildId = `lore_${'c'.repeat(64)}` as BuildId;

        const result = await run(
          ['--cwd', temp.root, 'rollback', '--target', 'cloudflare', buildId],
          {
            commands: [
              rollbackCommand({
                resolveTarget: async () => fakeRemoteRollbackTarget(calls),
              }),
            ],
          },
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`Active build: ${buildId}`);
        expect(calls).toEqual([`rollback:${buildId}`]);
      },
    );
  });
});

describe('lore prune', () => {
  async function manyBuilds(root: string, count: number) {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      writeFileSync(join(root, 'a.md'), `# A\n\nRevision ${index}.`, 'utf8');
      ids.push((await build(root)).buildId);
    }
    return ids;
  }

  it('prints a plan and removes nothing without --yes', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const ids = await manyBuilds(root, 8);
      const result = await lore(['prune']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Nothing was removed');
      expect(readdirSync(join(root, '.lore', 'builds'))).toHaveLength(ids.length);
    });
  });

  it('never claims a removal it did not make', async () => {
    // #150. `prune --yes` closed with "Removed." unconditionally, and the dry run offered
    // `--yes` even when there was nothing for it to do. Both statements were false, which
    // for a destructive command is the worst kind of copy defect.
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await build(root);

      const dryRun = await lore(['prune']);
      expect(dryRun.stdout).toContain('Nothing to remove');
      expect(dryRun.stdout).not.toContain('Re-run with --yes');

      const applied = await lore(['prune', '--yes']);
      expect(applied.code).toBe(0);
      expect(applied.stdout).toContain('Nothing to remove');
      expect(applied.stdout).not.toContain('Removed');
    });
  });

  it('says what it removed, in numbers that agree with themselves', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await manyBuilds(root, 2);
      const result = await lore(['prune', '--keep', '0', '--yes']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Removing 1 build, keeping 1');
      expect(result.stdout).toMatch(/Removed 1 build and \d+ objects?\./);
      expect(result.stdout).not.toContain('1 builds');
    });
  });

  it('keeps the active build and the previous five', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const ids = await manyBuilds(root, 8);
      const result = await lore(['prune', '--yes']);

      expect(result.code).toBe(0);
      const remaining = readdirSync(join(root, '.lore', 'builds')).sort();
      expect(remaining).toHaveLength(6);
      expect(remaining).toContain(ids.at(-1) ?? '');
      expect(remaining).not.toContain(ids[0]);
    });
  });

  it('never deletes an object a retained build still references', async () => {
    // Objects are content addressed and shared. Deleting one still in use would break the
    // very builds retention exists to protect.
    await project(
      { 'a.md': '# A\n\nText.', 'keep.md': '# Keep\n\nStable.' },
      async (root, lore) => {
        await manyBuilds(root, 8);
        await lore(['prune', '--yes']);

        const active = readActiveBuild(join(root, '.lore'));
        const objects = readdirSync(join(root, '.lore', 'objects', 'sha256'), { recursive: true });
        expect(objects.length).toBeGreaterThan(0);

        // The retained active build must still answer, which requires its objects.
        const status = JSON.parse((await lore(['--json', 'status'])).stdout);
        expect(status.activeBuildId).toBe(active?.buildId);
        expect(status.sourceState).toBe('clean');
      },
    );
  });

  it('respects an explicit --keep', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await manyBuilds(root, 8);
      await lore(['prune', '--keep', '1', '--yes']);
      expect(readdirSync(join(root, '.lore', 'builds'))).toHaveLength(2);
    });
  });

  it('rejects a nonsense --keep', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await build(root);
      const result = await lore(['prune', '--keep', 'lots', '--yes']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('whole number');
    });
  });

  it('leaves a project with few builds untouched', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await build(root);
      const result = await lore(['prune', '--yes']);
      expect(result.stdout).toContain('Nothing to remove');
      expect(existsSync(join(root, '.lore', 'builds'))).toBe(true);
    });
  });

  it('plans Cloudflare cleanup from verified remote history and excludes projected-only builds', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const db = new DatabaseSync(':memory:');
      writeCloudflareReceipt(temp.root);

      db.exec(`
        CREATE TABLE active_build (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          build_id TEXT,
          generation INTEGER NOT NULL
        );
        INSERT INTO active_build (id, build_id, generation)
        VALUES (1, 'lore_${'f'.repeat(64)}', 4);
        CREATE TABLE projected_builds (
          project_id TEXT NOT NULL,
          build_id TEXT NOT NULL,
          build_schema_version INTEGER NOT NULL,
          compiler_version TEXT NOT NULL,
          projection_schema_version INTEGER NOT NULL,
          projected_at TEXT NOT NULL,
          verified_at TEXT,
          activated_at TEXT,
          PRIMARY KEY (project_id, build_id)
        );
        CREATE TABLE artifacts (
          id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          build_id TEXT NOT NULL,
          source_id TEXT,
          relative_path TEXT NOT NULL,
          display_path TEXT NOT NULL,
          media_type TEXT NOT NULL,
          byte_size INTEGER,
          content_hash TEXT,
          parser_id TEXT,
          parser_version TEXT,
          title TEXT,
          status TEXT NOT NULL,
          authority INTEGER NOT NULL,
          object_hash TEXT NOT NULL,
          metadata_json TEXT,
          PRIMARY KEY (project_id, build_id, id)
        );
      `);

      for (const [buildId, projectedAt, verifiedAt] of [
        [`lore_${'9'.repeat(64)}`, '2026-08-09T12:07:00.000Z', null],
        [`lore_${'f'.repeat(64)}`, '2026-08-09T12:06:00.000Z', '2026-08-09T12:06:30.000Z'],
        [`lore_${'e'.repeat(64)}`, '2026-08-09T12:05:00.000Z', '2026-08-09T12:05:30.000Z'],
        [`lore_${'d'.repeat(64)}`, '2026-08-09T12:04:00.000Z', '2026-08-09T12:04:30.000Z'],
        [`lore_${'c'.repeat(64)}`, '2026-08-09T12:03:00.000Z', '2026-08-09T12:03:30.000Z'],
        [`lore_${'b'.repeat(64)}`, '2026-08-09T12:02:00.000Z', '2026-08-09T12:02:30.000Z'],
        [`lore_${'a'.repeat(64)}`, '2026-08-09T12:01:00.000Z', '2026-08-09T12:01:30.000Z'],
        [`lore_${'0'.repeat(64)}`, '2026-08-09T12:00:00.000Z', '2026-08-09T12:00:30.000Z'],
      ] as const) {
        db.prepare(
          `INSERT INTO projected_builds
            (project_id, build_id, build_schema_version, compiler_version, projection_schema_version, projected_at, verified_at, activated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run('demo', buildId, 1, '0.1.0', 4, projectedAt, verifiedAt, verifiedAt);
      }

      db.prepare(
        `INSERT INTO artifacts
          (id, project_id, build_id, source_id, relative_path, display_path, media_type, byte_size, content_hash, parser_id, parser_version, title, status, authority, object_hash, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'keep-shared',
        'demo',
        `lore_${'a'.repeat(64)}`,
        'keep.md',
        'keep.md',
        'keep.md',
        'text/markdown',
        10,
        '1'.repeat(64),
        'markdown',
        '1.0.0',
        'Keep',
        'active',
        50,
        'shared'.padEnd(64, 's'),
        '{}',
      );
      db.prepare(
        `INSERT INTO artifacts
          (id, project_id, build_id, source_id, relative_path, display_path, media_type, byte_size, content_hash, parser_id, parser_version, title, status, authority, object_hash, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'remove-shared',
        'demo',
        `lore_${'0'.repeat(64)}`,
        'remove-shared.md',
        'remove-shared.md',
        'remove-shared.md',
        'text/markdown',
        10,
        '2'.repeat(64),
        'markdown',
        '1.0.0',
        'Remove shared',
        'active',
        50,
        'shared'.padEnd(64, 's'),
        '{}',
      );
      db.prepare(
        `INSERT INTO artifacts
          (id, project_id, build_id, source_id, relative_path, display_path, media_type, byte_size, content_hash, parser_id, parser_version, title, status, authority, object_hash, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'remove-unique',
        'demo',
        `lore_${'9'.repeat(64)}`,
        'remove-unique.md',
        'remove-unique.md',
        'remove-unique.md',
        'text/markdown',
        10,
        '3'.repeat(64),
        'markdown',
        '1.0.0',
        'Remove unique',
        'active',
        50,
        'unique'.padEnd(64, 'u'),
        '{}',
      );

      const result = await run(['--cwd', temp.root, 'prune', '--target', 'cloudflare'], {
        commands: [
          pruneCommand({
            cloudflareAdapter: fakeCloudflareRollbackAdapter(db),
          }),
        ],
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        'Cloudflare cleanup plan: removing 2 remote builds, keeping 6',
      );
      expect(result.stdout).toContain(`lore_${'9'.repeat(64)}`);
      expect(result.stdout).toContain(`lore_${'0'.repeat(64)}`);
      expect(result.stdout).toContain('2 build archives');
      expect(result.stdout).toContain('1 unreferenced object');

      const jsonResult = await run(
        ['--json', '--cwd', temp.root, 'prune', '--target', 'cloudflare'],
        {
          commands: [pruneCommand({ cloudflareAdapter: fakeCloudflareRollbackAdapter(db) })],
        },
      );
      const parsed = JSON.parse(jsonResult.stdout) as {
        target: string;
        applied: boolean;
        keep: string[];
        remove: string[];
        objectKeysToRemove: string[];
      };
      expect(parsed.target).toBe('cloudflare');
      expect(parsed.applied).toBe(false);
      expect(parsed.keep).toHaveLength(6);
      expect(parsed.remove).toEqual([`lore_${'9'.repeat(64)}`, `lore_${'0'.repeat(64)}`]);
      expect(parsed.objectKeysToRemove).toEqual([
        `demo/objects/sha256/${'unique'.padEnd(64, 'u').slice(0, 2)}/${'unique'.padEnd(64, 'u').slice(2, 4)}/${'unique'.padEnd(64, 'u').slice(4)}`,
      ]);
      db.close();
    });
  });

  it('applies Cloudflare cleanup and reports exact D1 and R2 removals', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      writeCloudflareReceipt(temp.root);
      const humanFixture = seedRemoteCleanupFixture(new DatabaseSync(':memory:'));

      const result = await run(['--cwd', temp.root, 'prune', '--target', 'cloudflare', '--yes'], {
        commands: [
          pruneCommand({
            cloudflareAdapter: fakeCloudflareRollbackAdapter(humanFixture.db, humanFixture.objects),
          }),
        ],
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Cloudflare cleanup applied: removed 1 remote build, kept 2.');
      expect(result.stdout).toContain('1 projected build');
      expect(result.stdout).toContain('1 build archive and 1 unreferenced object.');
      expect(result.stdout).toContain('Dropped 1 physical table.');
      expect(humanFixture.objects.deletedKeys).toEqual([
        humanFixture.archiveKey,
        humanFixture.objectKey,
      ]);

      const jsonFixture = seedRemoteCleanupFixture(new DatabaseSync(':memory:'));
      const jsonResult = await run(
        ['--json', '--cwd', temp.root, 'prune', '--target', 'cloudflare', '--yes'],
        {
          commands: [
            pruneCommand({
              cloudflareAdapter: fakeCloudflareRollbackAdapter(jsonFixture.db, jsonFixture.objects),
            }),
          ],
        },
      );
      const parsed = JSON.parse(jsonResult.stdout) as {
        applied: boolean;
        remove: string[];
        d1: { physicalTablesDropped: string[] };
        r2: { archiveKeysRemoved: string[]; objectKeysRemoved: string[] };
      };
      expect(parsed.applied).toBe(true);
      expect(parsed.remove).toEqual([`lore_${'c'.repeat(64)}`]);
      expect(parsed.d1.physicalTablesDropped).toEqual(['projected_demo_remove']);
      expect(parsed.r2.archiveKeysRemoved).toEqual([jsonFixture.archiveKey]);
      expect(parsed.r2.objectKeysRemoved).toEqual([jsonFixture.objectKey]);
      humanFixture.db.close();
      jsonFixture.db.close();
    });
  });
});
