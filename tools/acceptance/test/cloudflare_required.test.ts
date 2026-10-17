import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const ACCEPTANCE = join(REPO_ROOT, 'tools', 'acceptance');
const VITEST = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const BINARY = join(REPO_ROOT, 'packages', 'cli', 'dist', 'entry.js');

it.each(['required', 'optional'] as const)(
  '%s Cloudflare acceptance reports missing credentials truthfully',
  (mode) => {
    expect(existsSync(BINARY), 'Build the real CLI before running this regression.').toBe(true);
    const artifacts = mkdtempSync(join(tmpdir(), 'lore-cf-required-'));
    const env: NodeJS.ProcessEnv = { ...process.env, LORE_CF_ARTIFACT_DIR: artifacts };
    for (const name of [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'LORE_CF_TEST_PREFIX',
      'LORE_CF_REQUIRED',
    ]) {
      delete env[name];
    }
    if (mode === 'required') env.LORE_CF_REQUIRED = '1';
    try {
      const result = spawnSync(
        process.execPath,
        [VITEST, 'run', 'test/cloudflare-smoke.test.ts', 'test/cloudflare-testing.test.ts'],
        { cwd: ACCEPTANCE, env, encoding: 'utf8', timeout: 120_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      const output = result.stdout + result.stderr;
      if (mode === 'required') {
        expect(result.status, output).not.toBe(0);
        expect(output).toContain('Cloudflare acceptance requires credentials');
      } else {
        expect(result.status, output).toBe(0);
        expect(output).toContain('skipped');
      }
      for (const suite of ['cloudflare-smoke', 'cloudflare-testing']) {
        expect(
          JSON.parse(readFileSync(join(artifacts, `${suite}.summary.json`), 'utf8')),
        ).toMatchObject({
          suite,
          credentialed: false,
          missing: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'LORE_CF_TEST_PREFIX'],
        });
      }
    } finally {
      rmSync(artifacts, { recursive: true, force: true });
    }
  },
  130_000,
);
