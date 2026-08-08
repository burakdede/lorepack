import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import type { DeploymentTarget, DeploymentReceipt, DeployInput, DeployPlan } from '@lorepack/core';
import { LoreError } from '@lorepack/core';
import { deployCommand } from '../src/commands/deploy.js';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: deployed\nsources:\n  - .\n';

function fakeTarget(
  options: { readonly calls?: string[]; readonly failResume?: boolean } = {},
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
        capabilityLoss: [],
        steps: ['project metadata', 'upload archive'],
        endpoint: 'https://example.workers.dev/mcp',
      };
    },
    apply: async (_plan, resume): Promise<DeploymentReceipt> => {
      calls.push(resume === undefined ? 'apply' : `apply:${resume.receiptId}`);
      if (options.failResume === true && resume !== undefined) {
        throw new LoreError('LORE_E_REMOTE_DEPLOY', 'resume failed', {
          remediation: 'Try again.',
          details: { receiptId: resume.receiptId },
        });
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

describe('lore deploy command, issue 91', () => {
  it('builds implicitly, prints the local and remote plan, and deploys with --yes', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n', 'docs/pricing.csv': 'name,price\nBasic,5\n' } },
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
        expect(result.stdout).toContain('Deploy plan for cloudflare');
        expect(result.stdout).toContain('Target');
        expect(result.stdout).toContain('Build');
        expect(result.stdout).toContain('Resources');
        expect(result.stdout).toContain('Projection');
        expect(result.stdout).toContain('Activation');
        expect(result.stdout).toContain('Endpoint: https://example.workers.dev/mcp');
        expect(result.stdout).toContain('Receipt:');
        expect(calls).toContain('apply');
        expect(calls).toContain('activate');
      },
    );
  });

  it('performs zero remote writes under --dry-run', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } }, async (temp) => {
      const calls: string[] = [];
      const result = await run(['--cwd', temp.root, 'deploy', 'cloudflare', '--yes', '--dry-run'], {
        commands: [
          deployCommand({
            resolveTarget: async () => fakeTarget({ calls }),
            confirm: async () => true,
          }),
        ],
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Dry run only. Nothing remote was changed.');
      expect(calls).toEqual(expect.arrayContaining(['detect']));
      expect(calls).toEqual(expect.arrayContaining([expect.stringMatching(/^plan:lore_/)]));
      expect(calls).not.toContain('apply');
    });
  });

  it('fails on a dirty working set when --no-build is given', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'deploy', 'cloudflare', '--no-build', '--yes'], {
        commands: [
          deployCommand({
            resolveTarget: async () => fakeTarget(),
            confirm: async () => true,
          }),
        ],
      });

      expect(result.code ?? 1).toBe(1);
      expect(result.stderr).toContain('LORE_E_INVALID_ARGUMENT');
      expect(result.stderr).toContain('omit `--no-build`');
    });
  });

  it('resumes from a named receipt without rebuilding', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A\n' } }, async (temp) => {
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
        ['--cwd', temp.root, 'deploy', 'cloudflare', '--yes', '--resume', 'cloudflare-aaaaaaaaaaaa'],
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
      expect(calls).toEqual(['detect', `plan:${buildId}`, 'verify', 'activate']);
      expect(result.stdout).toContain('Active build:');
    });
  });
});
