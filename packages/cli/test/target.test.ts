import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type {
  ProjectionMigrationDatabaseLike,
  ProjectionMigrationStatementLike,
  RuntimeAuthDatabaseLike,
  RuntimeAuthStatementLike,
} from '@lorepack/deploy-cloudflare';
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

function createTargetAdapter() {
  const db = new DatabaseSync(':memory:');
  const catalog = new SqliteTargetDatabase(db);
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
    openCatalogDatabase: () => catalog,
  };
  return { db, adapter };
}

describe('lore target add cloudflare, issue 85', () => {
  it('prints a deterministic plan and writes nothing under --dry-run', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const result = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare', '--dry-run'], {
          commands: [
            targetCommand({
              adapter: {
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
              },
            }),
          ],
        });

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Cloudflare target plan for Deploy Demo');
        expect(result.stdout).toContain('Worker: deploy-demo-runtime');
        expect(result.stdout).toContain('D1 catalog: deploy-demo-catalog');
        expect(result.stdout).toContain('R2 objects: deploy-demo-objects');
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
                adapter: {
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
                },
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
        const command = targetCommand({
          adapter: {
            detect: async () => ({ installed: true, version: '4.119.0', path: '/tmp/wrangler.js' }),
            whoami: async () => ({
              authenticated: true,
              email: 'dev@example.com',
              accountName: 'Example Account',
              accountId: 'acct_123',
            }),
          },
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
        const command = targetCommand({
          adapter: {
            detect: async () => ({ installed: true, version: '4.119.0', path: '/tmp/wrangler.js' }),
            whoami: async () => ({
              authenticated: true,
              email: 'dev@example.com',
              accountName: 'Example Account',
              accountId: 'acct_123',
            }),
          },
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

  it('refuses a non-dry-run setup without explicit existing-resource identifiers', async () => {
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
                whoami: async () => ({
                  authenticated: true,
                  email: 'dev@example.com',
                  accountName: 'Example Account',
                  accountId: 'acct_123',
                }),
              },
            }),
          ],
        });

        expect(result.code).toBe(5);
        expect(result.stderr).toContain('LORE_E_TARGET_NOT_CONFIGURED');
        expect(result.stderr).toContain('--account-id');
        expect(result.stderr).toContain('--worker');
      },
    );
  });
});

describe('lore target token cloudflare, issue 90', () => {
  it('generates a runtime token once and stores only its hash remotely', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const { db, adapter } = createTargetAdapter();
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
        const { db, adapter } = createTargetAdapter();
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
        ) as { token: string; rotated: boolean };
        expect(rotated.rotated).toBe(true);
        expect(rotated.token).not.toBe(first.token);

        const rows = db
          .prepare('SELECT token_hash, created_at FROM runtime_tokens ORDER BY token_hash')
          .all() as Array<{ token_hash: string; created_at: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.created_at).toBe('2026-08-09T10:05:00.000Z');

        const revoked = await run(
          ['--json', '--cwd', temp.root, 'target', 'token', 'cloudflare', '--revoke'],
          { commands: [command] },
        );
        expect(revoked.code).toBe(0);
        expect(JSON.parse(revoked.stdout)).toMatchObject({
          worker: 'demo-runtime',
          revoked: 1,
        });
        expect(
          (db.prepare('SELECT token_hash FROM runtime_tokens').all() as unknown[]).length,
        ).toBe(0);

        db.close();
      },
    );
  });
});
