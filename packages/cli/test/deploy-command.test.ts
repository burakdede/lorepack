import { mkdirSync, writeFileSync } from 'node:fs';
import type {
  Capability,
  DeployApplyProgress,
  DeployInput,
  DeploymentReceipt,
  DeploymentTarget,
  DeployPlan,
} from '@lorepack/core';
import { LoreError } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deployCommand } from '../src/commands/deploy.js';
import type { CloudflareResolverAdapter } from '../src/services/cloudflare-target.js';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: deployed\nsources:\n  - .\n';

function fakeTarget(
  options: {
    readonly calls?: string[];
    readonly failResume?: boolean;
    readonly applyProgress?: readonly DeployApplyProgress[];
    readonly applyProgressDelayMs?: number;
    readonly capabilityLoss?: readonly Capability[];
  } = {},
): DeploymentTarget {
  const calls = options.calls ?? [];
  return {
    id: 'cloudflare',
    detect: async () => {
      calls.push('detect');
      return { installed: true, version: '1.0.0' };
    },
    capabilities: async () => ({ supported: ['lexical-search', 'structured-context'] }),
    plan: async (input: DeployInput): Promise<DeployPlan> => {
      calls.push(`plan:${input.buildId}`);
      return {
        target: 'cloudflare',
        input,
        capabilityLoss: [...(options.capabilityLoss ?? [])],
        steps: ['project metadata', 'upload archive'],
        endpoint: 'https://example.workers.dev/mcp',
        display: {
          targetLabel: 'cloudflare / personal',
          resourceLines: [
            '= Worker deployed-runtime',
            '= D1 deployed-catalog',
            '= R2 deployed-objects',
          ],
          projectionLines: [
            '+ 1 artifact',
            '~ 0 artifacts',
            '= 0 artifacts reused by content hash',
            '+ 1 chunk',
            '+ 0 table rows',
          ],
          activationLines: [`current none`, `next    ${input.buildId}`],
        },
      };
    },
    apply: async (_plan, resume, progress): Promise<DeploymentReceipt> => {
      calls.push(resume === undefined ? 'apply' : `apply:${resume.receiptId}`);
      if (options.failResume === true && resume !== undefined) {
        throw new LoreError('LORE_E_REMOTE_DEPLOY', 'resume failed', {
          remediation: 'Try again.',
          details: { receiptId: resume.receiptId },
        });
      }
      for (const update of options.applyProgress ?? []) {
        progress?.(update);
        if ((options.applyProgressDelayMs ?? 0) > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.applyProgressDelayMs));
        }
      }
      return (
        resume ?? {
          formatVersion: 1,
          receiptId: 'cloudflare-aaaaaaaaaaaa',
          target: 'cloudflare',
          project: 'deployed',
          buildId: _plan.input.buildId,
          previousBuildId: null,
          state: 'projecting',
          deployedAt: '2026-08-08T00:00:00.000Z',
          endpoint: _plan.endpoint,
          capabilityLossAccepted: [],
          completedSteps: ['plan'],
          verification: { search: 'skipped', sourceRead: 'skipped', tableQuery: 'skipped' },
        }
      );
    },
    verify: async () => {
      calls.push('verify');
      return { search: 'passed', sourceRead: 'passed', tableQuery: 'skipped' };
    },
    activate: async (receipt) => {
      calls.push('activate');
      return {
        buildId: receipt.buildId,
        previousBuildId: null,
        confirmedBuildId: receipt.buildId,
        endpoint: 'https://example.workers.dev/mcp',
      };
    },
    rollback: async (buildId) => ({
      buildId,
      previousBuildId: null,
      confirmedBuildId: buildId,
      endpoint: 'https://example.workers.dev/mcp',
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function writeCloudflareReceipt(
  root: string,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  mkdirSync(`${root}/.lore/targets`, { recursive: true });
  writeFileSync(
    `${root}/.lore/targets/cloudflare.json`,
    `${JSON.stringify(
      {
        formatVersion: 1,
        target: 'cloudflare',
        project: 'deployed',
        configuredAt: '2026-08-08T00:00:00.000Z',
        wranglerVersion: '4.119.0',
        accountId: 'acc-1',
        workerName: 'deployed-runtime',
        catalogDatabaseName: 'deployed-catalog',
        objectsBucketName: 'deployed-objects',
        capabilities: ['lexical-search', 'structured-context', 'table-query'],
        ...overrides,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function fakeCloudflareAdapter(
  overrides: Partial<CloudflareResolverAdapter> = {},
): CloudflareResolverAdapter {
  return {
    detect: async () => ({ installed: true, version: '4.119.0', path: '/tmp/wrangler.js' }),
    whoami: async () => ({
      authenticated: true,
      email: 'dev@example.com',
      accountId: 'acc-1',
      accountName: 'Example',
    }),
    listDatabases: async () => [{ name: 'deployed-catalog' }],
    openCatalogDatabase: () => ({
      prepare: () => ({
        bind() {
          return this;
        },
        async run() {
          return {};
        },
        async first() {
          return null;
        },
      }),
    }),
    openObjectsBucket: () => ({
      async put() {},
      async get() {
        return null;
      },
      async head() {
        return null;
      },
    }),
    ...overrides,
  };
}

function normalizeDeployOutput(root: string, text: string): string {
  const fromPlan = text.includes('Plan for ') ? text.slice(text.indexOf('Plan for ')) : text;
  return fromPlan
    .replaceAll(root, '<PROJECT_ROOT>')
    .replaceAll(/lore_[0-9a-f]{64}/g, 'lore_<BUILD_ID>')
    .replaceAll(/cloudflare-[0-9a-f]{12}/g, 'cloudflare-<RECEIPT_ID>');
}

describe('lore deploy command, issue 91', () => {
  it('builds implicitly, prints the local and remote plan, and deploys with --yes', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': CONFIG,
          'docs/a.md': '# A\n',
          'docs/pricing.csv': 'name,price\nBasic,5\n',
        },
      },
      async (temp) => {
        const calls: string[] = [];
        const result = await run(['--cwd', temp.root, 'deploy', 'cloudflare', '--yes'], {
          commands: [
            deployCommand({
              resolveTarget: async () => fakeTarget({ calls }),
              confirm: async () => true,
            }),
          ],
        });

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Plan for first build');
        expect(result.stdout).toContain('Target: cloudflare / personal');
        expect(result.stdout).toContain('= Worker deployed-runtime');
        expect(result.stdout).toContain('= D1 deployed-catalog');
        expect(result.stdout).toContain('= R2 deployed-objects');
        expect(result.stdout).toContain('+ 1 artifact');
        expect(result.stdout).toContain('= 0 artifacts reused by content hash');
        expect(result.stdout).toContain('current none');
        expect(result.stdout).toContain('Endpoint: https://example.workers.dev/mcp');
        expect(result.stdout).toContain('Receipt:');
        expect(calls).toContain('apply');
        expect(calls).toContain('activate');
      },
    );
  });

  it('performs zero remote writes under --dry-run', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const calls: string[] = [];
        const result = await run(
          ['--cwd', temp.root, 'deploy', 'cloudflare', '--yes', '--dry-run'],
          {
            commands: [
              deployCommand({
                resolveTarget: async () => fakeTarget({ calls }),
                confirm: async () => true,
              }),
            ],
          },
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Target: cloudflare / personal');
        expect(result.stdout).toContain('= Worker deployed-runtime');
        expect(result.stdout).toContain('+ 1 artifact');
        expect(result.stdout).toContain('Dry run only. Nothing remote was changed.');
        expect(calls).toEqual(expect.arrayContaining(['detect']));
        expect(calls).toEqual(expect.arrayContaining([expect.stringMatching(/^plan:lore_/)]));
        expect(calls).not.toContain('apply');
      },
    );
  });

  it('fails on a dirty working set when --no-build is given', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const result = await run(
          ['--cwd', temp.root, 'deploy', 'cloudflare', '--no-build', '--yes'],
          {
            commands: [
              deployCommand({
                resolveTarget: async () => fakeTarget(),
                confirm: async () => true,
              }),
            ],
          },
        );

        expect(result.code ?? 1).toBe(1);
        expect(result.stderr).toContain('LORE_E_INVALID_ARGUMENT');
        expect(result.stderr).toContain('omit `--no-build`');
      },
    );
  });

  it('resumes from a named receipt without rebuilding', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const initial = await run(['--cwd', temp.root, 'build']);
        expect(initial.code).toBe(0);

        const receiptPath = `${temp.root}/.lore/receipts/cloudflare-aaaaaaaaaaaa.json`;
        const buildId = initial.stdout.match(/Build (lore_[0-9a-f]{64})/)?.[1];
        expect(buildId).toBeDefined();

        const receipt: DeploymentReceipt = {
          formatVersion: 1,
          receiptId: 'cloudflare-aaaaaaaaaaaa',
          target: 'cloudflare',
          project: 'deployed',
          buildId: buildId as DeploymentReceipt['buildId'],
          previousBuildId: null,
          state: 'failed',
          deployedAt: '2026-08-08T00:00:00.000Z',
          endpoint: 'https://example.workers.dev/mcp',
          capabilityLossAccepted: [],
          completedSteps: ['plan', 'project'],
          verification: { search: 'skipped', sourceRead: 'skipped', tableQuery: 'skipped' },
        };
        await import('node:fs').then(({ mkdirSync, writeFileSync }) => {
          mkdirSync(`${temp.root}/.lore/receipts`, { recursive: true });
          writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
        });

        const calls: string[] = [];
        const result = await run(
          [
            '--cwd',
            temp.root,
            'deploy',
            'cloudflare',
            '--yes',
            '--resume',
            'cloudflare-aaaaaaaaaaaa',
          ],
          {
            commands: [
              deployCommand({
                resolveTarget: async () => fakeTarget({ calls }),
                confirm: async () => true,
              }),
            ],
          },
        );

        expect(result.code).toBe(0);
        expect(calls).not.toContain('apply:cloudflare-aaaaaaaaaaaa');
        expect(calls).toEqual([`plan:${buildId}`, 'detect', 'verify', 'activate']);
        expect(result.stdout).toContain('Active build:');
      },
    );
  });

  it('forces a resumable failure after projection only under the test hook env', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const initial = await run(['--cwd', temp.root, 'build']);
        expect(initial.code).toBe(0);

        vi.stubEnv('LORE_TEST_ALLOW_HOOKS', '1');
        vi.stubEnv('LORE_TEST_FAIL_DEPLOY_AFTER_PROJECT', '1');

        const calls: string[] = [];
        const failed = await run(['--cwd', temp.root, 'deploy', 'cloudflare', '--yes'], {
          commands: [
            deployCommand({
              resolveTarget: async () => fakeTarget({ calls }),
              confirm: async () => true,
            }),
          ],
        });

        expect(failed.code ?? 1).toBeGreaterThan(0);
        expect(failed.stderr).toContain('Forced test failure after candidate projection.');
        expect(failed.stderr).toContain('Resume with `lore deploy cloudflare --resume');
        expect(calls).toEqual(
          expect.arrayContaining(['detect', expect.stringMatching(/^plan:lore_/), 'apply']),
        );
        expect(calls).not.toContain('verify');

        const receiptId = failed.stderr.match(/--resume (cloudflare-[0-9a-f]{12})/)?.[1];
        expect(receiptId).toBeDefined();

        vi.stubEnv('LORE_TEST_FAIL_DEPLOY_AFTER_PROJECT', '0');
        const resumedCalls: string[] = [];
        const resumed = await run(
          ['--cwd', temp.root, 'deploy', 'cloudflare', '--yes', '--resume', receiptId ?? ''],
          {
            commands: [
              deployCommand({
                resolveTarget: async () => fakeTarget({ calls: resumedCalls }),
                confirm: async () => true,
              }),
            ],
          },
        );

        expect(resumed.code).toBe(0);
        expect(resumedCalls).not.toContain(`apply:${receiptId}`);
        expect(resumedCalls).toEqual(expect.arrayContaining(['detect', 'verify', 'activate']));
        expect(resumed.stdout).toContain('Active build:');
      },
    );
  });

  it('cancels before any remote write when confirmation is declined', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const calls: string[] = [];
        const result = await run(['--cwd', temp.root, 'deploy', 'cloudflare'], {
          commands: [
            deployCommand({
              resolveTarget: async () => fakeTarget({ calls }),
              confirm: async () => false,
            }),
          ],
        });

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Target: cloudflare / personal');
        expect(result.stdout).toContain('Cancelled. Nothing was changed.');
        expect(calls).not.toContain('apply');
        expect(calls).not.toContain('activate');
      },
    );
  });

  it('fails clearly in a non-interactive environment when --yes is omitted', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const result = await run(['--cwd', temp.root, 'deploy', 'cloudflare'], {
          commands: [deployCommand({ resolveTarget: async () => fakeTarget() })],
        });

        expect(result.code ?? 1).toBe(1);
        expect(result.stderr).toContain('LORE_E_INVALID_ARGUMENT');
        expect(result.stderr).toContain('Deploy confirmation requires a terminal');
        expect(result.stderr).toContain('Re-run with `--yes`');
      },
    );
  });

  it('requires the named capability-loss override and succeeds when it is given', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const denied = await run(['--cwd', temp.root, 'deploy', 'cloudflare', '--yes'], {
          commands: [
            deployCommand({
              resolveTarget: async () => fakeTarget({ capabilityLoss: ['table-query'] }),
            }),
          ],
        });

        expect(denied.code ?? 1).toBeGreaterThan(0);
        expect(denied.stderr).toContain('LORE_E_CAPABILITY_LOSS');
        expect(denied.stderr).toContain('--allow-capability-loss table-query');

        const accepted = await run(
          [
            '--cwd',
            temp.root,
            'deploy',
            'cloudflare',
            '--yes',
            '--allow-capability-loss',
            'table-query',
          ],
          {
            commands: [
              deployCommand({
                resolveTarget: async () => fakeTarget({ capabilityLoss: ['table-query'] }),
              }),
            ],
          },
        );

        expect(accepted.code).toBe(0);
        expect(accepted.stdout).toContain('Deployed');
      },
    );
  });

  it('resolves the default cloudflare target from the checked-in receipt under --dry-run', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        writeCloudflareReceipt(temp.root);
        vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));

        const result = await run(
          ['--cwd', temp.root, 'deploy', 'cloudflare', '--yes', '--dry-run'],
          {
            commands: [deployCommand({ cloudflareAdapter: fakeCloudflareAdapter() })],
          },
        );

        expect(result.code).toBe(0);
        expect(normalizeDeployOutput(temp.root, result.stdout)).toBe(
          [
            'Plan for first build',
            '',
            'Artifacts',
            '  + 1 added',
            '  ~ 0 changed',
            '  - 0 removed',
            '  = 0 reused',
            '',
            '  + docs/a.md',
            '',
            'Lock',
            '  ~ lore.lock absent -> created',
            '',
            'Expected work',
            '  1 artifact to process: 1 parsed, 0 reused from cache',
            '  about 3 chunks rebuilt',
            '',
            'Target: cloudflare / personal',
            'Build:  lore_<BUILD_ID>',
            '',
            'Resources',
            '  = Worker deployed-runtime',
            '  = D1 deployed-catalog',
            '  = R2 deployed-objects',
            '',
            'Projection',
            '  + 1 artifact',
            '  ~ 0 artifacts',
            '  = 0 artifacts reused by content hash',
            '  + 0 chunks',
            '  + 0 table rows',
            '  ~ about 0 projected D1 bytes',
            '',
            'Activation',
            '  current none',
            '  next    lore_<BUILD_ID>',
            '',
            'Dry run only. Nothing remote was changed.',
            'Receipt id: cloudflare-<RECEIPT_ID>',
            '',
          ].join('\n'),
        );
      },
    );
  });

  it('emits the receipt as json while keeping the plan on stderr under --json', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        writeCloudflareReceipt(temp.root);
        vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));

        const result = await run(
          ['--json', '--cwd', temp.root, 'deploy', 'cloudflare', '--yes', '--dry-run'],
          {
            commands: [deployCommand({ cloudflareAdapter: fakeCloudflareAdapter() })],
          },
        );

        const receipt = JSON.parse(result.stdout) as DeploymentReceipt;
        expect(result.code).toBe(0);
        expect(receipt).toMatchObject({
          formatVersion: 1,
          receiptId: expect.stringMatching(/^cloudflare-[0-9a-f]{12}$/),
          target: 'cloudflare',
          project: 'deployed',
          buildId: expect.stringMatching(/^lore_[0-9a-f]{64}$/),
          endpoint: 'https://deployed-runtime.workers.dev/mcp',
          state: 'planned',
        });
        expect(result.stdout).not.toContain('Target: cloudflare / personal');
        expect(result.stdout).not.toContain('Dry run only. Nothing remote was changed.');
        expect(result.stderr).toContain('Discovering');
        expect(result.stderr).toContain('Validating');
      },
    );
  });

  it('fails clearly when the cloudflare target receipt is missing', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const result = await run(
          ['--cwd', temp.root, 'deploy', 'cloudflare', '--yes', '--dry-run'],
          {
            commands: [deployCommand({ cloudflareAdapter: fakeCloudflareAdapter() })],
          },
        );

        expect(result.code ?? 1).toBe(5);
        expect(result.stderr).toContain('LORE_E_TARGET_NOT_CONFIGURED');
        expect(result.stderr).toContain('Run `lore target add cloudflare` first.');
      },
    );
  });

  it('fails clearly when the cloudflare target receipt is unreadable', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        mkdirSync(`${temp.root}/.lore/targets`, { recursive: true });
        writeFileSync(`${temp.root}/.lore/targets/cloudflare.json`, '{not-json\n', 'utf8');

        const result = await run(
          ['--cwd', temp.root, 'deploy', 'cloudflare', '--yes', '--dry-run'],
          {
            commands: [deployCommand({ cloudflareAdapter: fakeCloudflareAdapter() })],
          },
        );

        expect(result.code ?? 1).toBe(5);
        expect(result.stderr).toContain('LORE_E_TARGET_NOT_CONFIGURED');
        expect(result.stderr).toContain('could not be read');
      },
    );
  });

  it('rejects a receipt from a different Cloudflare account', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        writeCloudflareReceipt(temp.root, { accountId: 'acc-2' });

        const result = await run(
          ['--cwd', temp.root, 'deploy', 'cloudflare', '--yes', '--dry-run'],
          {
            commands: [deployCommand({ cloudflareAdapter: fakeCloudflareAdapter() })],
          },
        );

        expect(result.code ?? 1).toBe(5);
        expect(result.stderr).toContain('LORE_E_TARGET_NOT_CONFIGURED');
        expect(result.stderr).toContain('belongs to account acc-2');
      },
    );
  });

  it('rejects a receipt whose D1 database is not visible to the current account', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        writeCloudflareReceipt(temp.root, { catalogDatabaseName: 'missing-catalog' });

        const result = await run(
          ['--cwd', temp.root, 'deploy', 'cloudflare', '--yes', '--dry-run'],
          {
            commands: [
              deployCommand({
                cloudflareAdapter: fakeCloudflareAdapter({
                  listDatabases: async () => [{ name: 'deployed-catalog' }],
                }),
              }),
            ],
          },
        );

        expect(result.code ?? 1).toBe(5);
        expect(result.stderr).toContain('LORE_E_TARGET_NOT_CONFIGURED');
        expect(result.stderr).toContain('missing-catalog');
        expect(result.stderr).toContain('not visible');
      },
    );
  });

  it('prints measurable projection and upload progress during a slow deploy', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } },
      async (temp) => {
        const result = await run(['--cwd', temp.root, 'deploy', 'cloudflare', '--yes'], {
          commands: [
            deployCommand({
              resolveTarget: async () =>
                fakeTarget({
                  applyProgress: [
                    {
                      stage: 'projecting',
                      completed: 1,
                      total: 4,
                      unit: 'steps',
                      detail: 'metadata',
                    },
                    {
                      stage: 'uploading',
                      completed: 2048,
                      total: 4096,
                      unit: 'bytes',
                      detail: '1/2 objects, 1 uploaded, 0 skipped',
                    },
                  ],
                  applyProgressDelayMs: 1100,
                }),
              confirm: async () => true,
            }),
          ],
        });

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Projecting');
        expect(result.stdout).toContain('1/4 steps metadata');
        expect(result.stdout).toContain('Uploading');
        expect(result.stdout).toContain('2,048/4,096 bytes 1/2 objects, 1 uploaded, 0 skipped');
      },
    );
  });
});
