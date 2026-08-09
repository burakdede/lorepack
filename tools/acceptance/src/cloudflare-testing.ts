import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const REQUIRED_ENV_VARS = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'LORE_CF_TEST_PREFIX',
] as const;

export type CloudflareTestingEnvVar = (typeof REQUIRED_ENV_VARS)[number];

export interface CloudflareTestingEnv {
  readonly apiToken: string;
  readonly accountId: string;
  readonly testPrefix: string;
  readonly runId: string | null;
  readonly runAttempt: string | null;
}

export interface CloudflareArtifactSummary {
  readonly suite: string;
  readonly credentialed: boolean;
  readonly missing: readonly CloudflareTestingEnvVar[];
  readonly note?: string;
}

export function cloudflareArtifactDirectory(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const value = env.LORE_CF_ARTIFACT_DIR;
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (isAbsolute(trimmed)) return trimmed;
  const base = env.GITHUB_WORKSPACE?.trim() || process.cwd();
  return resolve(base, trimmed);
}

export function writeCloudflareArtifactSummary(
  env: Readonly<Record<string, string | undefined>>,
  summary: CloudflareArtifactSummary,
): string | null {
  const directory = cloudflareArtifactDirectory(env);
  if (directory === null) return null;

  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${summary.suite}.summary.json`);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        suite: summary.suite,
        credentialed: summary.credentialed,
        missing: summary.missing,
        note: summary.note ?? null,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return path;
}

const SAFE_PREFIX = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const SAFE_RUN_COMPONENT = /^[0-9]+$/;

export function requiredCloudflareTestingEnv(): readonly CloudflareTestingEnvVar[] {
  return REQUIRED_ENV_VARS;
}

export function missingCloudflareTestingEnv(
  env: Readonly<Record<string, string | undefined>>,
): readonly CloudflareTestingEnvVar[] {
  return REQUIRED_ENV_VARS.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === '';
  });
}

export function readCloudflareTestingEnv(
  env: Readonly<Record<string, string | undefined>>,
): CloudflareTestingEnv {
  const missing = missingCloudflareTestingEnv(env);
  if (missing.length > 0) {
    throw new Error(`Missing Cloudflare integration environment: ${missing.join(', ')}`);
  }

  const apiToken = readRequiredEnv(env, 'CLOUDFLARE_API_TOKEN');
  const accountId = readRequiredEnv(env, 'CLOUDFLARE_ACCOUNT_ID');
  const testPrefix = readRequiredEnv(env, 'LORE_CF_TEST_PREFIX').toLowerCase();
  const runId = trimOptional(env.GITHUB_RUN_ID);
  const runAttempt = trimOptional(env.GITHUB_RUN_ATTEMPT);

  if (!SAFE_PREFIX.test(testPrefix)) {
    throw new Error(
      'LORE_CF_TEST_PREFIX must be lowercase alphanumeric or hyphen, 1 to 24 characters, and must start and end with an alphanumeric character.',
    );
  }
  if (runId !== null && !SAFE_RUN_COMPONENT.test(runId)) {
    throw new Error('GITHUB_RUN_ID must be numeric when present.');
  }
  if (runAttempt !== null && !SAFE_RUN_COMPONENT.test(runAttempt)) {
    throw new Error('GITHUB_RUN_ATTEMPT must be numeric when present.');
  }

  return { apiToken, accountId, testPrefix, runId, runAttempt };
}

export function resourcePrefixFor(env: CloudflareTestingEnv): string {
  return [env.testPrefix, env.runId, env.runAttempt].filter((value) => value !== null).join('-');
}

function trimOptional(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readRequiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: CloudflareTestingEnvVar,
): string {
  const value = env[name];
  if (value === undefined) {
    throw new Error(`Missing Cloudflare integration environment: ${name}`);
  }
  return value.trim();
}
