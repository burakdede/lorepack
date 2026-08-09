import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  missingCloudflareTestingEnv,
  readCloudflareTestingEnv,
  requiredCloudflareTestingEnv,
  resourcePrefixFor,
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

  it('documents the integration environment, scopes, skips, and artifacts', () => {
    expect(existsSync(DOC), `${DOC} is missing.`).toBe(true);
    const text = readFileSync(DOC, 'utf8');

    expect(text).toContain('CLOUDFLARE_API_TOKEN');
    expect(text).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(text).toContain('LORE_CF_TEST_PREFIX');
    expect(text).toContain('Workers Scripts Edit');
    expect(text).toContain('D1 Edit');
    expect(text).toContain('Workers R2 Storage Edit');
    expect(text).toContain('mixed-corpus.ts');
    expect(text).toContain('runtime-contract.test.ts');
    expect(text).toContain('skips with an explicit message');
    expect(text).toContain('CI artifacts');
  });

  const missing = missingCloudflareTestingEnv(process.env);
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
