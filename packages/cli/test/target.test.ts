import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type {
  ProjectionMigrationDatabaseLike,
  ProjectionMigrationStatementLike,
  RuntimeAuthDatabaseLike,
  RuntimeAuthStatementLike,
} from '@lorepack/deploy-cloudflare';
import { runProjectionMigrations } from '@lorepack/deploy-cloudflare';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { targetCommand } from '../src/commands/target.js';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: Deploy Demo\nsources:\n  - .\n';

class SqliteStatement implements ProjectionMigrationStatementLike, RuntimeAuthStatementLike {
  readonly #db: DatabaseSync;
  readonly #query: string;
  #bindings: readonly unknown[] = [];

  constructor(db: DatabaseSync, query: string) {
    this.#db = db;
    this.#query = query;
  }

  bind(...values: unknown[]): ProjectionMigrationStatementLike & RuntimeAuthStatementLike {
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

class SqliteTargetDatabase implements ProjectionMigrationDatabaseLike, RuntimeAuthDatabaseLike {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  prepare(query: string): ProjectionMigrationStatementLike & RuntimeAuthStatementLike {
    return new SqliteStatement(this.#db, query);
  }
}

function createTargetAdapter(
  options: {
    readonly catalogs?: readonly string[];
    readonly buckets?: readonly string[];
    readonly workers?: readonly string[];
  } = {},
) {
  const db = new DatabaseSync(':memory:');
  const catalog = new SqliteTargetDatabase(db);
  const setup = createSetupAdapter(options);
  const adapter = {
    ...setup.adapter,
    openCatalogDatabase: () => catalog,
  };
  return { db, adapter };
}

function createSetupAdapter(
  options: {
    readonly catalogs?: readonly string[];
    readonly buckets?: readonly string[];
    readonly workers?: readonly string[];
    readonly failCatalogCreate?: string;
    readonly failBucketCreate?: string;
  } = {},
) {
  const state = {
    catalogs: new Set(options.catalogs ?? []),
    buckets: new Set(options.buckets ?? []),
    workers: new Set(options.workers ?? []),
    createdCatalogs: [] as string[],
    createdBuckets: [] as string[],
  };
  const adapter = {
    detect: async () => ({
      installed: true,
      version: '4.119.0',
      path: '/tmp/wrangler.js',
    }),
    whoami: async () => ({
      authenticated: true,
      email: 'dev@example.com',
      accountName: 'Example Account',
      accountId: 'acct_123',
    }),
    inspectResources: async ({
      workerName,
      catalogDatabaseName,
      objectsBucketName,
    }: {
      readonly workerName: string;
      readonly catalogDatabaseName: string;
      readonly objectsBucketName: string;
    }) => ({
      workerExists: state.workers.has(workerName),
      catalogDatabaseExists: state.catalogs.has(catalogDatabaseName),
      objectsBucketExists: state.buckets.has(objectsBucketName),
    }),
    createCatalogDatabase: async (name: string) => {
      if (options.failCatalogCreate === name) throw new Error('catalog quota exceeded');
      state.catalogs.add(name);
      state.createdCatalogs.push(name);
    },
    createObjectsBucket: async (name: string) => {
      if (options.failBucketCreate === name) throw new Error('bucket name conflict');
      state.buckets.add(name);
      state.createdBuckets.push(name);
    },
  };
  return { adapter, state };
}

describe('lore target add cloudflare, issue 85', () => {
  it('prints a deterministic plan and writes nothing under --dry-run', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const result = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare', '--dry-run'], {
          commands: [
            targetCommand({
              adapter: createSetupAdapter().adapter,
            }),
          ],
        });

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Cloudflare target plan for Deploy Demo');
        expect(result.stdout).toContain('Worker: reserve deploy-demo-runtime for the first deploy');
        expect(result.stdout).toContain('D1 catalog: create deploy-demo-catalog');
        expect(result.stdout).toContain('R2 objects: create deploy-demo-objects');
        expect(result.stdout).toContain('docs/integrations/cloudflare-target-setup.md');
        expect(result.stdout).toContain('(dry run, nothing was changed)');
        expect(existsSync(`${temp.root}/.lore/targets/cloudflare.json`)).toBe(false);
      },
    );
  });

  it('prints the exact login command when wrangler is unauthenticated', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const result = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare', '--yes'], {
          commands: [
            targetCommand({
              adapter: {
                detect: async () => ({
                  installed: true,
                  version: '4.119.0',
                  path: '/tmp/wrangler.js',
                }),
                whoami: async () => ({ authenticated: false }),
              },
            }),
          ],
        });

        expect(result.code).toBe(5);
        expect(result.stderr).toContain('LORE_E_TARGET_NOT_CONFIGURED');
        expect(result.stderr).toContain('/tmp/wrangler.js login --device');
      },
    );
  });

  it('writes a non-secret receipt when connecting existing resources', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const result = await run(
          [
            '--cwd',
            temp.root,
            'target',
            'add',
            'cloudflare',
            '--yes',
            '--account-id',
            'acct_123',
            '--worker',
            'demo-runtime',
            '--catalog-db',
            'demo-catalog',
            '--objects-bucket',
            'demo-objects',
          ],
          {
            commands: [
              targetCommand({
                adapter: createSetupAdapter({
                  catalogs: ['demo-catalog'],
                  buckets: ['demo-objects'],
                }).adapter,
                now: () => new Date('2026-08-08T15:00:00.000Z'),
              }),
            ],
          },
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Receipt:');

        const path = `${temp.root}/.lore/targets/cloudflare.json`;
        const receipt = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        expect(receipt).toMatchObject({
          formatVersion: 1,
          target: 'cloudflare',
          project: 'Deploy Demo',
          configuredAt: '2026-08-08T15:00:00.000Z',
          wranglerVersion: '4.119.0',
          accountId: 'acct_123',
          workerName: 'demo-runtime',
          catalogDatabaseName: 'demo-catalog',
          objectsBucketName: 'demo-objects',
          capabilities: ['lexical-search', 'structured-context', 'table-query'],
        });
        const raw = readFileSync(path, 'utf8');
        expect(raw).not.toContain('token');
        expect(raw).not.toContain('dev@example.com');
      },
    );
  });

  it('is idempotent when rerun against an unchanged receipt', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const args = [
          '--cwd',
          temp.root,
          'target',
          'add',
          'cloudflare',
          '--yes',
          '--account-id',
          'acct_123',
          '--worker',
          'demo-runtime',
          '--catalog-db',
          'demo-catalog',
          '--objects-bucket',
          'demo-objects',
        ];
        const { adapter } = createSetupAdapter({
          catalogs: ['demo-catalog'],
          buckets: ['demo-objects'],
        });
        const command = targetCommand({
          adapter,
          now: () => new Date('2026-08-08T15:00:00.000Z'),
        });

        const first = await run(args, { commands: [command] });
        expect(first.code).toBe(0);
        const path = `${temp.root}/.lore/targets/cloudflare.json`;
        const before = readFileSync(path, 'utf8');

        const second = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare', '--yes'], {
          commands: [command],
        });

        expect(second.code).toBe(0);
        expect(second.stdout).toContain('already matches');
        expect(readFileSync(path, 'utf8')).toBe(before);
      },
    );
  });

  it('reports receipt drift when rerun asks for different resources', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const { adapter } = createSetupAdapter({
          catalogs: ['demo-catalog'],
          buckets: ['demo-objects'],
        });
        const command = targetCommand({
          adapter,
          now: () => new Date('2026-08-08T15:00:00.000Z'),
        });
        await run(
          [
            '--cwd',
            temp.root,
            'target',
            'add',
            'cloudflare',
            '--yes',
            '--account-id',
            'acct_123',
            '--worker',
            'demo-runtime',
            '--catalog-db',
            'demo-catalog',
            '--objects-bucket',
            'demo-objects',
          ],
          { commands: [command] },
        );

        const drift = await run(
          ['--cwd', temp.root, 'target', 'add', 'cloudflare', '--yes', '--worker', 'other-runtime'],
          { commands: [command] },
        );

        expect(drift.code).toBe(5);
        expect(drift.stderr).toContain('LORE_E_TARGET_NOT_CONFIGURED');
        expect(drift.stderr).toContain('workerName');
        expect(drift.stderr).toContain('receipt=demo-runtime requested=other-runtime');
      },
    );
  });

  it('provisions deterministic D1 and R2 resources when no explicit identifiers are supplied', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const { adapter, state } = createSetupAdapter();
        const result = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare', '--yes'], {
          commands: [
            targetCommand({
              adapter,
              now: () => new Date('2026-08-09T11:00:00.000Z'),
            }),
          ],
        });

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('D1 catalog: create deploy-demo-catalog');
        expect(result.stdout).toContain('R2 objects: create deploy-demo-objects');
        expect(state.createdCatalogs).toEqual(['deploy-demo-catalog']);
        expect(state.createdBuckets).toEqual(['deploy-demo-objects']);

        const receipt = JSON.parse(
          readFileSync(`${temp.root}/.lore/targets/cloudflare.json`, 'utf8'),
        ) as CloudflareTargetReceipt;
        expect(receipt.accountId).toBe('acct_123');
        expect(receipt.workerName).toBe('deploy-demo-runtime');
        expect(receipt.catalogDatabaseName).toBe('deploy-demo-catalog');
        expect(receipt.objectsBucketName).toBe('deploy-demo-objects');
      },
    );
  });

  it('fails clearly when deterministic names are already in use before the first receipt', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const result = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare', '--yes'], {
          commands: [
            targetCommand({
              adapter: createSetupAdapter({
                catalogs: ['deploy-demo-catalog'],
              }).adapter,
            }),
          ],
        });

        expect(result.code).toBe(5);
        expect(result.stderr).toContain('LORE_E_TARGET_NOT_CONFIGURED');
        expect(result.stderr).toContain(
          'deterministic Cloudflare resource names are already in use',
        );
        expect(result.stderr).toContain('Connect those resources explicitly');
      },
    );
  });

  it('reports remote drift when the receipt points at resources that no longer exist', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const { adapter, state } = createSetupAdapter();
        const command = targetCommand({
          adapter,
          now: () => new Date('2026-08-09T11:00:00.000Z'),
        });
        const first = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare', '--yes'], {
          commands: [command],
        });
        expect(first.code).toBe(0);

        state.buckets.delete('deploy-demo-objects');

        const drift = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare', '--yes'], {
          commands: [command],
        });

        expect(drift.code).toBe(5);
        expect(drift.stderr).toContain('LORE_E_TARGET_NOT_CONFIGURED');
        expect(drift.stderr).toContain('remote resources that are missing');
        expect(drift.stderr).toContain('R2 objects');
      },
    );
  });

  it('wraps provisioning failures as actionable target setup errors', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const result = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare', '--yes'], {
          commands: [
            targetCommand({
              adapter: createSetupAdapter({
                failBucketCreate: 'deploy-demo-objects',
              }).adapter,
            }),
          ],
        });

        expect(result.code).toBe(5);
        expect(result.stderr).toContain('LORE_E_TARGET_NOT_CONFIGURED');
        expect(result.stderr).toContain(
          'Cloudflare resource provisioning failed during target setup',
        );
        expect(result.stderr).toContain('Check the token permissions');
      },
    );
  });
});

describe('lore target token cloudflare, issue 90', () => {
  it('generates a runtime token once and stores only its hash remotely', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const { db, adapter } = createTargetAdapter({
          catalogs: ['demo-catalog'],
          buckets: ['demo-objects'],
        });
        const command = targetCommand({
          adapter,
          now: () => new Date('2026-08-09T10:00:00.000Z'),
        });

        const setup = await run(
          [
            '--cwd',
            temp.root,
            'target',
            'add',
            'cloudflare',
            '--yes',
            '--account-id',
            'acct_123',
            '--worker',
            'demo-runtime',
            '--catalog-db',
            'demo-catalog',
            '--objects-bucket',
            'demo-objects',
          ],
          { commands: [command] },
        );
        expect(setup.code).toBe(0);

        const issued = await run(['--json', '--cwd', temp.root, 'target', 'token', 'cloudflare'], {
          commands: [command],
        });
        expect(issued.code).toBe(0);
        const payload = JSON.parse(issued.stdout) as {
          token: string;
          rotated: boolean;
          worker: string;
        };
        expect(payload.rotated).toBe(false);
        expect(payload.worker).toBe('demo-runtime');
        expect(payload.token).toMatch(/^lore_rt_[0-9a-f]{48}$/);

        const rows = db
          .prepare('SELECT token_hash, created_at FROM runtime_tokens ORDER BY token_hash')
          .all() as Array<{ token_hash: string; created_at: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(rows[0]?.token_hash).not.toContain(payload.token);
        expect(rows[0]?.created_at).toBe('2026-08-09T10:00:00.000Z');

        const second = await run(['--cwd', temp.root, 'target', 'token', 'cloudflare'], {
          commands: [command],
        });
        expect(second.code).toBe(5);
        expect(second.stderr).toContain('A runtime token already exists');

        db.close();
      },
    );
  });

  it('rotates and revokes the runtime token', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const { db, adapter } = createTargetAdapter({
          catalogs: ['demo-catalog'],
          buckets: ['demo-objects'],
        });
        let now = '2026-08-09T10:00:00.000Z';
        const command = targetCommand({
          adapter,
          now: () => new Date(now),
        });

        await run(
          [
            '--cwd',
            temp.root,
            'target',
            'add',
            'cloudflare',
            '--yes',
            '--account-id',
            'acct_123',
            '--worker',
            'demo-runtime',
            '--catalog-db',
            'demo-catalog',
            '--objects-bucket',
            'demo-objects',
          ],
          { commands: [command] },
        );

        const first = JSON.parse(
          (
            await run(['--json', '--cwd', temp.root, 'target', 'token', 'cloudflare'], {
              commands: [command],
            })
          ).stdout,
        ) as { token: string };

        now = '2026-08-09T10:05:00.000Z';
        const rotated = JSON.parse(
          (
            await run(['--json', '--cwd', temp.root, 'target', 'token', 'cloudflare', '--rotate'], {
              commands: [command],
            })
          ).stdout,
        ) as {
          token: string;
          rotated: boolean;
          overlapEndsAt: string;
          activeTokens: Array<{
            tokenHash: string;
            createdAt: string;
            expiresAt: string | null;
          }>;
        };
        expect(rotated.rotated).toBe(true);
        expect(rotated.token).not.toBe(first.token);
        expect(rotated.overlapEndsAt).toBe('2026-08-09T10:15:00.000Z');

        const rows = db
          .prepare(
            'SELECT token_hash, created_at, expires_at FROM runtime_tokens ORDER BY created_at, token_hash',
          )
          .all() as Array<{ token_hash: string; created_at: string; expires_at: string | null }>;
        expect(rows).toHaveLength(2);
        expect(rows[0]?.created_at).toBe('2026-08-09T10:00:00.000Z');
        expect(rows[0]?.expires_at).toBe('2026-08-09T10:15:00.000Z');
        expect(rows[1]?.created_at).toBe('2026-08-09T10:05:00.000Z');
        expect(rows[1]?.expires_at).toBeNull();
        expect(rotated.activeTokens).toHaveLength(2);

        const revoked = await run(
          ['--json', '--cwd', temp.root, 'target', 'token', 'cloudflare', '--revoke'],
          { commands: [command] },
        );
        expect(revoked.code).toBe(0);
        expect(JSON.parse(revoked.stdout)).toMatchObject({
          worker: 'demo-runtime',
          revoked: 2,
        });
        expect(
          (db.prepare('SELECT token_hash FROM runtime_tokens').all() as unknown[]).length,
        ).toBe(0);

        db.close();
      },
    );
  });
});

describe('lore target status cloudflare, issue 92', () => {
  it('lists remote projected builds newest first with the active marker, deploy time, and state', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const { db, adapter } = createTargetAdapter({
          catalogs: ['demo-catalog'],
          buckets: ['demo-objects'],
        });
        const command = targetCommand({
          adapter,
          now: () => new Date('2026-08-09T10:00:00.000Z'),
        });

        const setup = await run(
          [
            '--cwd',
            temp.root,
            'target',
            'add',
            'cloudflare',
            '--yes',
            '--account-id',
            'acct_123',
            '--worker',
            'demo-runtime',
            '--catalog-db',
            'demo-catalog',
            '--objects-bucket',
            'demo-objects',
          ],
          { commands: [command] },
        );
        expect(setup.code).toBe(0);

        const catalog = new SqliteTargetDatabase(db);
        await runProjectionMigrations(catalog, () => '2026-08-09T10:01:00.000Z');
        db.prepare('UPDATE active_build SET build_id = ?, generation = ? WHERE id = 1').run(
          `lore_${'b'.repeat(64)}`,
          4,
        );
        db.prepare(
          `INSERT INTO projected_builds (
            project_id,
            build_id,
            build_schema_version,
            compiler_version,
            projection_schema_version,
            projected_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run('Deploy Demo', `lore_${'a'.repeat(64)}`, 1, '0.1.0', 1, '2026-08-09T10:02:00.000Z');
        db.prepare(
          `INSERT INTO projected_builds (
            project_id,
            build_id,
            build_schema_version,
            compiler_version,
            projection_schema_version,
            projected_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run('Deploy Demo', `lore_${'b'.repeat(64)}`, 1, '0.1.0', 1, '2026-08-09T10:03:00.000Z');

        const result = await run(['--cwd', temp.root, 'target', 'status', 'cloudflare'], {
          commands: [command],
        });

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Cloudflare target status for demo-runtime');
        expect(result.stdout).toContain('* active');
        const lines = result.stdout.split('\n').filter((line) => line.includes('lore_'));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain(`lore_${'b'.repeat(12)}`);
        expect(lines[0]).toContain('2026-08-09T10:03:00');
        expect(lines[0]).toContain('active');
        expect(lines[1]).toContain(`lore_${'a'.repeat(12)}`);
        expect(lines[1]).toContain('projected');

        const parsed = JSON.parse(
          (
            await run(['--json', '--cwd', temp.root, 'target', 'status', 'cloudflare'], {
              commands: [command],
            })
          ).stdout,
        ) as {
          target: string;
          worker: string;
          activeBuildId: string;
          builds: Array<{ buildId: string; deployedAt: string; state: string; active: boolean }>;
        };
        expect(parsed.target).toBe('cloudflare');
        expect(parsed.worker).toBe('demo-runtime');
        expect(parsed.activeBuildId).toBe(`lore_${'b'.repeat(64)}`);
        expect(parsed.builds).toEqual([
          {
            buildId: `lore_${'b'.repeat(64)}`,
            deployedAt: '2026-08-09T10:03:00.000Z',
            state: 'active',
            active: true,
          },
          {
            buildId: `lore_${'a'.repeat(64)}`,
            deployedAt: '2026-08-09T10:02:00.000Z',
            state: 'projected',
            active: false,
          },
        ]);
      },
    );
  });

  it('reports an empty remote target cleanly before the first deploy', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const { adapter } = createTargetAdapter({
          catalogs: ['demo-catalog'],
          buckets: ['demo-objects'],
        });
        const command = targetCommand({
          adapter,
          now: () => new Date('2026-08-09T10:00:00.000Z'),
        });

        const setup = await run(
          [
            '--cwd',
            temp.root,
            'target',
            'add',
            'cloudflare',
            '--yes',
            '--account-id',
            'acct_123',
            '--worker',
            'demo-runtime',
            '--catalog-db',
            'demo-catalog',
            '--objects-bucket',
            'demo-objects',
          ],
          { commands: [command] },
        );
        expect(setup.code).toBe(0);

        const result = await run(['--cwd', temp.root, 'target', 'status', 'cloudflare'], {
          commands: [command],
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('No remote projected builds yet.');

        const parsed = JSON.parse(
          (
            await run(['--json', '--cwd', temp.root, 'target', 'status', 'cloudflare'], {
              commands: [command],
            })
          ).stdout,
        ) as {
          activeBuildId: string | null;
          builds: unknown[];
        };
        expect(parsed.activeBuildId).toBeNull();
        expect(parsed.builds).toEqual([]);
      },
    );
  });
});
