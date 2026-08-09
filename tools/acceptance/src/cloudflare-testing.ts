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
