import { existsSync, readFileSync } from 'node:fs';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { targetCommand } from '../src/commands/target.js';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: Deploy Demo\nsources:\n  - .\n';

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
