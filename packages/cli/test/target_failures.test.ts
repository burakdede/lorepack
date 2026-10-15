import { existsSync, readFileSync } from 'node:fs';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import {
  type CloudflareTargetReceipt,
  readCloudflareTargetReceipt,
  targetCommand,
} from '../src/commands/target.js';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: Target Failures\nsources:\n  - .\n';
const RECEIPT = '.lore/targets/cloudflare.json';
const receipt: CloudflareTargetReceipt = {
  formatVersion: 1,
  target: 'cloudflare',
  project: 'Target Failures',
  configuredAt: '2026-10-15T00:00:00.000Z',
  wranglerVersion: '4.119.0',
  accountId: 'fixture-account',
  workerName: 'fixture-runtime',
  catalogDatabaseName: 'fixture-catalog',
  tablesDatabaseName: 'fixture-tables',
  objectsBucketName: 'fixture-objects',
  capabilities: ['lexical-search'],
};

function adapterFixture() {
  const calls: string[] = [];
  const adapter = {
    detect: async () => ({ installed: true, version: '4.119.0', path: 'fixture-wrangler.js' }),
    whoami: async () => ({ authenticated: true, accountId: receipt.accountId }),
    inspectResources: async () => ({
      workerExists: false,
      catalogDatabaseExists: false,
      tablesDatabaseExists: false,
      objectsBucketExists: false,
    }),
    createCatalogDatabase: async () => {
      calls.push('create catalog');
    },
    createTablesDatabase: async () => {
      calls.push('create tables');
    },
    createObjectsBucket: async () => {
      calls.push('create bucket');
    },
    openCatalogDatabase: () => {
      calls.push('open catalog');
      throw new Error('A rejected operation must not open its remote database.');
    },
  };
  return { adapter, calls };
}

describe('target commands reject unavailable prerequisites before mutation', () => {
  it.each([
    ['remove', 'cloudflare'],
    ['add', 'unknown'],
  ])('rejects an unknown target command %s %s', async (subject, target) => {
    const { adapter, calls } = adapterFixture();
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'target', subject, target], {
        commands: [targetCommand({ adapter })],
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('LORE_E_INVALID_ARGUMENT');
      expect(result.stderr).toContain(`Unknown target command: ${subject} ${target}`);
      expect(calls).toEqual([]);
    });
  });

  it('requires an account id before inspecting resources', async () => {
    const { adapter, calls } = adapterFixture();
    const unavailable = { ...adapter, whoami: async () => ({ authenticated: true }) };
    unavailable.inspectResources = async () => {
      throw new Error('Resource inspection needs an account first.');
    };
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare', '--yes'], {
        commands: [targetCommand({ adapter: unavailable })],
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('did not report a Cloudflare account id');
      expect(result.stderr).toContain('--account-id');
      expect(calls).toEqual([]);
      expect(existsSync(temp.path(RECEIPT))).toBe(false);
    });
  });

  it('requires a provisioning-capable adapter for setup', async () => {
    const { adapter, calls } = adapterFixture();
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare', '--yes'], {
        commands: [targetCommand({ adapter: { detect: adapter.detect, whoami: adapter.whoami } })],
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('cannot inspect or provision remote resources');
      expect(calls).toEqual([]);
    });
  });

  it('rejects contradictory token actions before opening a database', async () => {
    const { adapter, calls } = adapterFixture();
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const result = await run(
        ['--cwd', temp.root, 'target', 'token', 'cloudflare', '--rotate', '--revoke'],
        {
          commands: [targetCommand({ adapter })],
        },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('Choose either --rotate or --revoke, not both');
      expect(calls).toEqual([]);
    });
  });

  it.each(['add', 'status', 'token'])('reports missing Wrangler for %s', async (subject) => {
    const { adapter, calls } = adapterFixture();
    adapter.detect = async () => ({ installed: false, version: '', path: '' });
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'target', subject, 'cloudflare', '--yes'], {
        commands: [targetCommand({ adapter })],
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('LORE_E_TARGET_NOT_CONFIGURED');
      expect(result.stderr).toContain('Wrangler was not found');
      expect(calls).toEqual([]);
      expect(existsSync(temp.path(RECEIPT))).toBe(false);
    });
  });

  it.each(['status', 'token'])(
    'reports missing login for %s without reading the receipt',
    async (subject) => {
      const { adapter, calls } = adapterFixture();
      adapter.whoami = async () => ({ authenticated: false, accountId: '' });
      await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
        const result = await run(['--cwd', temp.root, 'target', subject, 'cloudflare'], {
          commands: [targetCommand({ adapter })],
        });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('no Cloudflare login');
        expect(result.stderr).toContain('login --device');
        expect(calls).toEqual([]);
      });
    },
  );

  it.each(['status', 'token'])(
    'refuses a different account for %s and retains the receipt',
    async (subject) => {
      const { adapter, calls } = adapterFixture();
      adapter.whoami = async () => ({ authenticated: true, accountId: 'other-account' });
      const original = `${JSON.stringify(receipt)}\n`;
      await withTempProject(
        { files: { 'lore.yaml': CONFIG, [RECEIPT]: original } },
        async (temp) => {
          const result = await run(['--cwd', temp.root, 'target', subject, 'cloudflare'], {
            commands: [targetCommand({ adapter })],
          });
          expect(result.code).not.toBe(0);
          expect(result.stderr).toContain('belongs to account fixture-account');
          expect(result.stderr).toContain('logged into other-account');
          expect(calls).toEqual([]);
          expect(readFileSync(temp.path(RECEIPT), 'utf8')).toBe(original);
        },
      );
    },
  );

  it.each(['status', 'token'])('requires a database-capable adapter for %s', async (subject) => {
    const { adapter, calls } = adapterFixture();
    const { openCatalogDatabase: _open, ...setupOnly } = adapter;
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'target', subject, 'cloudflare'], {
        commands: [targetCommand({ adapter: setupOnly })],
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('LORE_E_INTERNAL');
      expect(result.stderr).toContain('openCatalogDatabase()');
      expect(calls).toEqual([]);
    });
  });

  it.each([
    { flags: [], message: 'confirmation requires a terminal' },
    {
      flags: ['--yes', '--worker', 'existing'],
      message: 'requires explicit resource identifiers together',
    },
  ])('rejects incomplete setup: $message', async ({ flags, message }) => {
    const { adapter, calls } = adapterFixture();
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare', ...flags], {
        commands: [targetCommand({ adapter })],
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(calls).toEqual([]);
      expect(existsSync(temp.path(RECEIPT))).toBe(false);
    });
  });

  it('cancels setup without provisioning or writing a receipt', async () => {
    const { adapter, calls } = adapterFixture();
    const plans: string[] = [];
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare'], {
        commands: [
          targetCommand({
            adapter,
            confirm: async (plan) => {
              plans.push(plan);
              return false;
            },
          }),
        ],
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Cancelled. Nothing was changed.');
      expect(plans).toHaveLength(1);
      expect(plans[0]).toContain('D1 tables: create target-failures-tables');
      expect(calls).toEqual([]);
      expect(existsSync(temp.path(RECEIPT))).toBe(false);
    });
  });

  it('reports all missing explicit resources without provisioning them', async () => {
    const { adapter, calls } = adapterFixture();
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const result = await run(
        [
          '--cwd',
          temp.root,
          'target',
          'add',
          'cloudflare',
          '--yes',
          '--worker',
          receipt.workerName,
          '--catalog-db',
          receipt.catalogDatabaseName,
          '--tables-db',
          receipt.tablesDatabaseName ?? '',
          '--objects-bucket',
          receipt.objectsBucketName,
        ],
        {
          commands: [targetCommand({ adapter })],
        },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('not visible: D1 catalog, D1 tables, R2 objects');
      expect(calls).toEqual([]);
      expect(existsSync(temp.path(RECEIPT))).toBe(false);
    });
  });

  it('reports every changed receipt identifier and retains the original bytes', async () => {
    const { adapter, calls } = adapterFixture();
    const original = `${JSON.stringify(receipt)}\n`;
    await withTempProject({ files: { 'lore.yaml': CONFIG, [RECEIPT]: original } }, async (temp) => {
      const result = await run(
        [
          '--cwd',
          temp.root,
          'target',
          'add',
          'cloudflare',
          '--yes',
          '--account-id',
          'changed-account',
          '--worker',
          'changed-worker',
          '--catalog-db',
          'changed-catalog',
          '--tables-db',
          'changed-tables',
          '--objects-bucket',
          'changed-objects',
        ],
        {
          commands: [targetCommand({ adapter })],
        },
      );
      expect(result.code).not.toBe(0);
      for (const field of [
        'accountId',
        'workerName',
        'catalogDatabaseName',
        'tablesDatabaseName',
        'objectsBucketName',
      ]) {
        expect(result.stderr).toContain(field);
      }
      expect(result.stderr).toContain('receipt=fixture-account requested=changed-account');
      expect(calls).toEqual([]);
      expect(readFileSync(temp.path(RECEIPT), 'utf8')).toBe(original);
    });
  });

  it('refuses a receipt when provisioned resources remain invisible', async () => {
    const { adapter, calls } = adapterFixture();
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'target', 'add', 'cloudflare', '--yes'], {
        commands: [targetCommand({ adapter })],
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('did not leave the expected remote resources visible');
      expect(result.stderr).toContain('D1 catalog, D1 tables, R2 objects');
      expect(calls).toEqual(['create catalog', 'create tables', 'create bucket']);
      expect(existsSync(temp.path(RECEIPT))).toBe(false);
    });
  });
});

describe('persisted target receipt validation', () => {
  it.each([
    null,
    [],
    { ...receipt, formatVersion: 2 },
    { ...receipt, target: 'other' },
    ...[
      'project',
      'configuredAt',
      'wranglerVersion',
      'accountId',
      'workerName',
      'catalogDatabaseName',
      'objectsBucketName',
    ].map((field) => ({ ...receipt, [field]: null })),
    { ...receipt, tablesDatabaseName: 42 },
    { ...receipt, capabilities: 'lexical-search' },
    { ...receipt, capabilities: [1] },
    { ...receipt, endpoint: 42 },
    { ...receipt, endpoint: 'http://fixture.example' },
    { ...receipt, endpoint: 'https://fixture.example/path' },
    { ...receipt, endpoint: 'https://fixture.example/' },
  ])('rejects invalid receipt %# without rewriting it', async (invalid) => {
    const original = `${JSON.stringify(invalid)}\n`;
    await withTempProject({ files: { 'lore.yaml': CONFIG, [RECEIPT]: original } }, async (temp) => {
      expect(() => readCloudflareTargetReceipt(temp.root)).toThrow('is invalid');
      expect(readFileSync(temp.path(RECEIPT), 'utf8')).toBe(original);
    });
  });

  it('reports unreadable JSON separately from a missing receipt', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, [RECEIPT]: '{unfinished' } },
      async (temp) => {
        expect(() => readCloudflareTargetReceipt(temp.root)).toThrow('could not be read');
        expect(readFileSync(temp.path(RECEIPT), 'utf8')).toBe('{unfinished');
      },
    );
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      expect(() => readCloudflareTargetReceipt(temp.root)).toThrow(
        'has no cloudflare target receipt',
      );
    });
  });

  it('accepts a legacy receipt without an isolated table database or endpoint', async () => {
    const { tablesDatabaseName: _tables, ...legacy } = receipt;
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, [RECEIPT]: JSON.stringify(legacy) } },
      async (temp) => {
        expect(readCloudflareTargetReceipt(temp.root)).toEqual(legacy);
      },
    );
  });
});
