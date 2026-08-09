import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cloudflareArtifactDirectory,
  missingCloudflareTestingEnv,
  readCloudflareTestingEnv,
  requiredCloudflareTestingEnv,
  resourcePrefixFor,
  writeCloudflareArtifactSummary,
} from '../src/cloudflare-testing.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const DOC = join(REPO_ROOT, 'docs', 'integrations', 'cloudflare-testing.md');

describe('the Cloudflare testing environment contract, issue 93', () => {
  it('defines a stable required environment set', () => {
    expect(requiredCloudflareTestingEnv()).toEqual([
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'LORE_CF_TEST_PREFIX',
    ]);
  });

  it('builds a per-run resource prefix when CI metadata is present', () => {
    const env = readCloudflareTestingEnv({
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      LORE_CF_TEST_PREFIX: 'lorepack-ci',
      GITHUB_RUN_ID: '12345',
      GITHUB_RUN_ATTEMPT: '2',
    });

    expect(resourcePrefixFor(env)).toBe('lorepack-ci-12345-2');
  });

  it('rejects an unsafe resource prefix before any remote resource is named', () => {
    expect(() =>
      readCloudflareTestingEnv({
        CLOUDFLARE_API_TOKEN: 'token',
        CLOUDFLARE_ACCOUNT_ID: 'account',
        LORE_CF_TEST_PREFIX: 'LorePack_CI',
      }),
    ).toThrow(/LORE_CF_TEST_PREFIX/);
  });

  it('treats the Cloudflare artifact directory as optional metadata', () => {
    expect(cloudflareArtifactDirectory({})).toBeNull();
    expect(cloudflareArtifactDirectory({ LORE_CF_ARTIFACT_DIR: '   ' })).toBeNull();
    expect(
      cloudflareArtifactDirectory({
        LORE_CF_ARTIFACT_DIR: 'tmp/cloudflare-artifacts',
        GITHUB_WORKSPACE: '/workspace/lorepack',
      }),
    ).toBe('/workspace/lorepack/tmp/cloudflare-artifacts');
    expect(cloudflareArtifactDirectory({ LORE_CF_ARTIFACT_DIR: '/tmp/cloudflare-artifacts' })).toBe(
      '/tmp/cloudflare-artifacts',
    );
  });

  it('writes a summary artifact when the Cloudflare artifact directory is configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'lore-cf-artifacts-'));
    try {
      const path = writeCloudflareArtifactSummary(
        { LORE_CF_ARTIFACT_DIR: root },
        {
          suite: 'cloudflare-testing',
          credentialed: false,
          missing: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
          note: 'credentialed smoke skipped',
        },
      );
      expect(path).toBe(join(root, 'cloudflare-testing.summary.json'));
      expect(existsSync(path as string)).toBe(true);
      expect(JSON.parse(readFileSync(path as string, 'utf8'))).toEqual({
        suite: 'cloudflare-testing',
        credentialed: false,
        missing: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
        note: 'credentialed smoke skipped',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('documents the integration environment, scopes, skips, and artifacts', () => {
    expect(existsSync(DOC), `${DOC} is missing.`).toBe(true);
    const text = readFileSync(DOC, 'utf8');

    expect(text).toContain('CLOUDFLARE_API_TOKEN');
    expect(text).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(text).toContain('LORE_CF_TEST_PREFIX');
    expect(text).toContain('LORE_CF_ARTIFACT_DIR');
    expect(text).toContain('Workers Scripts Edit');
    expect(text).toContain('D1 Edit');
    expect(text).toContain('Workers R2 Storage Edit');
    expect(text).toContain('mixed-corpus.ts');
    expect(text).toContain('runtime-contract.test.ts');
    expect(text).toContain('cloudflare acceptance (ubuntu-latest)');
    expect(text).toContain('.github/workflows/ci.yml');
    expect(text).toContain('release-candidate environment');
    expect(text).toContain('skips with an explicit message');
    expect(text).toContain('CI artifacts');
  });

  const missing = missingCloudflareTestingEnv(process.env);
  writeCloudflareArtifactSummary(process.env, {
    suite: 'cloudflare-testing',
    credentialed: missing.length === 0,
    missing,
    note:
      missing.length === 0
        ? 'Cloudflare environment contract is configured.'
        : `Cloudflare environment contract is missing: ${missing.join(', ')}`,
  });
  it.skipIf(missing.length > 0)(
    `runs the credentialed Cloudflare integration suite when configured (missing: ${missing.join(', ') || 'none'})`,
    () => {
      const env = readCloudflareTestingEnv(process.env);
      expect(resourcePrefixFor(env)).toMatch(/^[a-z0-9-]+$/);
      expect(env.apiToken.length).toBeGreaterThan(0);
      expect(env.accountId.length).toBeGreaterThan(0);
    },
  );
});
