import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_CODES, verifyContextReceipt } from '@lorepack/core';
import type { BuildId, ContextBundle, SearchResult } from '@lorepack/core/worker';
import { MCP_PROTOCOL_VERSION } from '@lorepack/mcp';
import { describe, expect, it, vi } from 'vitest';
import {
  activeCloudflareWorkerName,
  addCloudflareCleanupProbe,
  addCloudflareTarget,
  addResumeMutationToken,
  addSemanticSearchCapability,
  buildProject,
  callRemoteMcpTool,
  cloudflareR2BucketListUrl,
  cloudflareR2Json,
  cloudflareWorkerDeleteUrl,
  cloudflareWorkerListUrl,
  createCloudflareSmokeProject,
  deployCloudflareTarget,
  deployCloudflareTargetExpectFailureAfterProject,
  isCloudflareWorkerPropagationError,
  isMissingCloudflareBucketError,
  isMissingCloudflareD1Error,
  isNonEmptyCloudflareBucketError,
  issueCloudflareRuntimeToken,
  parseCloudflareTargetReceipt,
  parseWranglerDeploymentInfo,
  provisionCloudflareSmokeTarget,
  readRemoteContext,
  remoteR2ObjectDeleteArgs,
  resumeCloudflareTarget,
  rollbackCloudflareTarget,
  sanitizeCloudflareCommandResult,
  smokeProjectName,
  staleCloudflareD1DatabaseNames,
  staleCloudflareR2BucketNames,
  staleCloudflareWorkerNames,
  teardownCloudflareSmokeTarget,
  waitForRemoteBuild,
  writeCloudflareSingletonWorkerReceipt,
  writeCommandArtifact,
} from '../src/cloudflare-smoke.js';
import {
  assertRequiredCloudflareTestingEnv,
  missingCloudflareTestingEnv,
  writeCloudflareArtifactSummary,
} from '../src/cloudflare-testing.js';

const BINARY = join(import.meta.dirname, '..', '..', '..', 'packages', 'cli', 'dist', 'entry.js');
const UNIQUE_QUERY = 'phase6-rollback-token';
const RESUME_MUTATION_QUERY = 'phase6-resume-mutation-token';
const UNIQUE_FILE = 'docs/phase6-rollback-proof.md';
const RECEIPTS_DIRECTORY = '.lore/receipts';
const STALE_CI_ENV = {
  accountId: 'test-account',
  testPrefix: 'lorepack-ci',
  runId: '101',
  runAttempt: '2',
};
const OLD_PROJECT = `lpci-${'a'.repeat(32)}`;
const EARLIER_ATTEMPT_PROJECT = `lpci-${'b'.repeat(32)}`;
const OWNERSHIP_RECORDS = [
  {
    ...STALE_CI_ENV,
    formatVersion: 1 as const,
    projectName: OLD_PROJECT,
    runId: '100',
    runAttempt: '1',
  },
  {
    ...STALE_CI_ENV,
    formatVersion: 1 as const,
    projectName: EARLIER_ATTEMPT_PROJECT,
    runId: '101',
    runAttempt: '1',
  },
  { ...STALE_CI_ENV, formatVersion: 1 as const, projectName: `lpci-${'c'.repeat(32)}` },
  {
    ...STALE_CI_ENV,
    formatVersion: 1 as const,
    projectName: `lpci-${'d'.repeat(32)}`,
    runId: '102',
    runAttempt: '1',
  },
] as const;
const MANUAL_CI_ENV = {
  accountId: 'test-account',
  testPrefix: 'lorepack-ci',
  runId: null,
  runAttempt: null,
};
const WORKERS_FOR_STALE_CLEANUP = [
  ...OWNERSHIP_RECORDS.map((record) => ({ name: `${record.projectName}-runtime` })),
  { name: 'lorepack-ci-acceptance-runtime' },
  { name: 'lorepack-ci-100-1-cloudflare-acceptance-runtime' },
  { name: 'lorepack-ci-101-1-cloudflare-acceptance-runtime' },
  { name: 'lorepack-ci-101-2-cloudflare-acceptance-runtime' },
  { name: 'lorepack-ci-102-1-cloudflare-acceptance-runtime' },
  { name: 'lorepack-ci-cloudflare-acceptance-runtime' },
  { name: 'other-ci-100-1-cloudflare-acceptance-runtime' },
  { name: 'lorepack-ci-100-1-cloudflare-acceptance-catalog' },
];
const MANUAL_WORKERS_FOR_STALE_CLEANUP = [
  ...OWNERSHIP_RECORDS.map((record) => ({ name: `${record.projectName}-runtime` })),
  { name: 'lorepack-ci-100-1-cloudflare-acceptance-runtime' },
];
const R2_BUCKETS_FOR_STALE_CLEANUP = [
  ...OWNERSHIP_RECORDS.map((record) => ({ name: `${record.projectName}-objects` })),
  { name: 'lorepack-ci-100-1-cloudflare-acceptance-objects' },
  { name: 'lorepack-ci-101-1-cloudflare-acceptance-objects' },
  { name: 'lorepack-ci-101-2-cloudflare-acceptance-objects' },
  { name: 'lorepack-ci-102-1-cloudflare-acceptance-objects' },
  { name: 'lorepack-ci-100-cloudflare-acceptance-objects' },
  { name: 'other-ci-100-1-cloudflare-acceptance-objects' },
  { name: 'lorepack-ci-100-1-cloudflare-acceptance-runtime' },
];
const MANUAL_R2_BUCKETS_FOR_STALE_CLEANUP = [
  ...OWNERSHIP_RECORDS.map((record) => ({ name: `${record.projectName}-objects` })),
  { name: 'lorepack-ci-100-1-cloudflare-acceptance-objects' },
];

describe('the credentialed Cloudflare smoke, issue 93', () => {
  it.each([
    ['Worker', staleCloudflareWorkerNames, 'runtime'],
    ['D1 catalog', staleCloudflareD1DatabaseNames, 'catalog'],
    ['D1 tables', staleCloudflareD1DatabaseNames, 'tables'],
    ['R2 bucket', staleCloudflareR2BucketNames, 'objects'],
  ] as const)(
    'never selects a production-shaped %s for cleanup, issue 622',
    (_, select, suffix) => {
      expect(
        select(
          [{ name: `lorepack-2026-10-product-research-${suffix}` }],
          {
            accountId: 'test-account',
            testPrefix: 'lorepack',
            runId: '38788779701',
            runAttempt: '1',
          },
          [],
        ),
      ).toEqual([]);
    },
  );

  it('builds a per-run unique project name when the Cloudflare environment is configured', () => {
    expect(
      smokeProjectName('Cloudflare Acceptance', {
        CLOUDFLARE_API_TOKEN: 'token',
        CLOUDFLARE_ACCOUNT_ID: 'account',
        LORE_CF_TEST_PREFIX: 'lorepack-ci',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '2',
      }),
    ).toMatch(/^lpci-[a-f0-9]{32}$/);
  });

  it('keeps the base project name when the Cloudflare environment is absent', () => {
    expect(smokeProjectName('Cloudflare Acceptance', {})).toBe('cloudflare-acceptance');
  });

  it('parses the actual Cloudflare target receipt returned by the CLI', () => {
    expect(
      parseCloudflareTargetReceipt(
        JSON.stringify({
          accountId: 'acc-1',
          workerName: 'cloudflare-acceptance-runtime',
          catalogDatabaseName: 'cloudflare-acceptance-catalog',
          tablesDatabaseName: 'cloudflare-acceptance-tables',
          objectsBucketName: 'cloudflare-acceptance-objects',
        }),
      ),
    ).toEqual({
      accountId: 'acc-1',
      workerName: 'cloudflare-acceptance-runtime',
      catalogDatabaseName: 'cloudflare-acceptance-catalog',
      tablesDatabaseName: 'cloudflare-acceptance-tables',
      objectsBucketName: 'cloudflare-acceptance-objects',
    });
  });

  it('uses the actual deployed Workers endpoint from Wrangler output', () => {
    expect(
      parseWranglerDeploymentInfo(
        [
          'Uploaded lorepack-ci-31329883479-1-cloudflare-acc-runtime (5.75 sec)',
          'Deployed lorepack-ci-31329883479-1-cloudflare-acc-runtime triggers (2.54 sec)',
          '  https://lorepack-ci-31329883479-1-cloudflare-acc-runtime.burakdede87.workers.dev',
          'Current Version ID: 57baedf4-f3b7-40df-8157-79d9d33e2466',
        ].join('\n'),
        'lorepack-ci-31329883479-1-cloudflare-acc-runtime',
      ),
    ).toEqual({
      endpointBase:
        'https://lorepack-ci-31329883479-1-cloudflare-acc-runtime.burakdede87.workers.dev',
    });
  });

  it('falls back to the plain workers.dev host when Wrangler prints no URL', () => {
    expect(
      parseWranglerDeploymentInfo(
        'Uploaded lorepack-ci-31329883479-1-cloudflare-acc-runtime',
        'lorepack-ci-31329883479-1-cloudflare-acc-runtime',
      ),
    ).toEqual({
      endpointBase: 'https://lorepack-ci-31329883479-1-cloudflare-acc-runtime.workers.dev',
    });
  });

  it('recognizes only the post-upload Worker propagation error as retryable', () => {
    expect(
      isCloudflareWorkerPropagationError(
        new Error(
          'A request to the Cloudflare API (/accounts/acc/workers/scripts/name/subdomain) failed.\nThis Worker does not exist on your account. [code: 10007]',
        ),
      ),
    ).toBe(true);
    expect(
      isCloudflareWorkerPropagationError(
        new Error(
          'A request to the Cloudflare API (/accounts/acc/workers/scripts/name) failed.\nThis Worker does not exist on your account. [code: 10007]',
        ),
      ),
    ).toBe(false);
    expect(
      isCloudflareWorkerPropagationError(
        new Error(
          'A request to the Cloudflare API (/accounts/acc/workers/scripts/name/subdomain) failed.\nUnauthorized [code: 10000]',
        ),
      ),
    ).toBe(false);
  });

  it('recognizes the newer Worker endpoint only after a matching successful upload', () => {
    const failure =
      'A request to the Cloudflare API (/accounts/acc/workers/workers/runtime) failed.\nThis Worker does not exist on your account. [code: 10007]';
    const uploaded = `${failure}\nUploaded runtime (1.76 sec)`;
    expect(isCloudflareWorkerPropagationError(new Error(uploaded))).toBe(true);
    for (const rejected of [
      failure,
      uploaded.replace('Uploaded runtime', 'Uploaded another-worker'),
      uploaded.replace('/workers/workers/runtime)', '/workers/workers/runtime/settings)'),
      uploaded.replace('[code: 10007]', '[code: 10000]'),
      uploaded.replace('This Worker does not exist on your account.', 'Unauthorized'),
      uploaded.replace('/accounts/acc/workers/workers/', '/unrelated/workers/workers/'),
    ])
      expect(isCloudflareWorkerPropagationError(new Error(rejected))).toBe(false);
  });

  it('builds the direct Cloudflare Worker delete URL from account and worker names', () => {
    expect(
      cloudflareWorkerDeleteUrl(
        'de1984edb8b3db5f67105c1bc99d1dca',
        'lorepack-ci-31329883479-1-cloudflare-acc-runtime',
      ),
    ).toBe(
      'https://api.cloudflare.com/client/v4/accounts/de1984edb8b3db5f67105c1bc99d1dca/workers/scripts/lorepack-ci-31329883479-1-cloudflare-acc-runtime',
    );
  });

  it('builds the direct Cloudflare Worker list URL from the account id', () => {
    expect(cloudflareWorkerListUrl('de1984edb8b3db5f67105c1bc99d1dca')).toBe(
      'https://api.cloudflare.com/client/v4/accounts/de1984edb8b3db5f67105c1bc99d1dca/workers/scripts',
    );
  });

  it('omits account-wide D1 inventory from artifacts without changing command output', () => {
    const result = {
      code: 0,
      stdout: JSON.stringify([
        { name: 'lorepack-ci-catalog', uuid: 'project-db-id' },
        { name: 'unrelated-production-db', uuid: 'unrelated-db-id' },
      ]),
      stderr: '',
    };

    const root = mkdtempSync(join(tmpdir(), 'lorepack-cloudflare-artifact-'));
    try {
      writeCommandArtifact(root, 1, 'wrangler', ['d1', 'list', '--json'], result, {});
      const artifactPath = join(root, readdirSync(root)[0] ?? 'missing.json');
      const artifact = readFileSync(artifactPath, 'utf8');

      expect(artifact).toContain('[account-wide D1 listing omitted from CI artifact]');
      expect(artifact).not.toContain('lorepack-ci-catalog');
      expect(artifact).not.toContain('unrelated-production-db');
      expect(artifact).not.toContain('project-db-id');
      expect(artifact).not.toContain('unrelated-db-id');
      expect(result.stdout).toContain('lorepack-ci-catalog');
      expect(result.stdout).toContain('unrelated-production-db');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts Cloudflare credentials from captured command output', () => {
    expect(
      sanitizeCloudflareCommandResult(
        'wrangler',
        ['r2', 'bucket', 'create', 'lorepack-ci-objects'],
        {
          code: 1,
          stdout: 'account: account-secret',
          stderr: 'token: api-secret',
        },
        {
          CLOUDFLARE_ACCOUNT_ID: 'account-secret',
          CLOUDFLARE_API_TOKEN: 'api-secret',
        },
      ),
    ).toEqual({
      code: 1,
      stdout: 'account: <redacted>',
      stderr: 'token: <redacted>',
    });
  });

  it('builds the direct Cloudflare R2 bucket list URL from the account id', () => {
    expect(cloudflareR2BucketListUrl('de1984edb8b3db5f67105c1bc99d1dca')).toBe(
      'https://api.cloudflare.com/client/v4/accounts/de1984edb8b3db5f67105c1bc99d1dca/r2/buckets',
    );
  });

  it('retries rate-limited R2 reads and honors Retry-After', async () => {
    const waits: number[] = [];
    const responses = [
      new Response(JSON.stringify({ success: false, errors: [{ message: 'slow down' }] }), {
        status: 429,
        headers: { 'Retry-After': '2' },
      }),
      new Response(JSON.stringify({ success: true, result: { name: 'ledger' } }), {
        status: 200,
      }),
    ];
    const fetchMock = vi.fn(async () => responses.shift() as Response);
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        cloudflareR2Json(
          new URL('https://api.cloudflare.com/client/v4/accounts/test/r2/buckets/ledger'),
          'GET',
          { CLOUDFLARE_API_TOKEN: 'token' },
          async (ms) => {
            waits.push(ms);
          },
        ),
      ).resolves.toEqual({ success: true, result: { name: 'ledger' } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(waits).toEqual([2_000]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps exhausted R2 rate limits as errors with the provider details', async () => {
    const waits: number[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ message: 'slow down', code: 971 }] }),
          {
            status: 429,
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        cloudflareR2Json(
          new URL('https://api.cloudflare.com/client/v4/accounts/test/r2/buckets/ledger'),
          'GET',
          { CLOUDFLARE_API_TOKEN: 'token' },
          async (ms) => {
            waits.push(ms);
          },
        ),
      ).rejects.toThrow('Cloudflare R2 GET failed (429): slow down [code: 971]');
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(waits).toEqual([500, 1_000, 2_000]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not retry other R2 API errors', async () => {
    const waits: number[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ message: 'unauthorized', code: 10000 }] }),
          {
            status: 401,
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        cloudflareR2Json(
          new URL('https://api.cloudflare.com/client/v4/accounts/test/r2/buckets/ledger'),
          'GET',
          { CLOUDFLARE_API_TOKEN: 'token' },
          async (ms) => {
            waits.push(ms);
          },
        ),
      ).rejects.toThrow('Cloudflare R2 GET failed (401): unauthorized [code: 10000]');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(waits).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('persists the deployed singleton endpoint in the target receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'lore-singleton-receipt-'));
    const path = join(root, '.lore', 'targets', 'cloudflare.json');
    const receipt = {
      accountId: 'account',
      workerName: 'project-runtime',
      catalogDatabaseName: 'project-catalog',
      tablesDatabaseName: 'project-tables',
      objectsBucketName: 'project-objects',
    };
    mkdirSync(join(root, '.lore', 'targets'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        ...receipt,
        endpoint: 'https://project-runtime.account.workers.dev',
        runtimeToken: 'preserved-token',
      }),
    );
    try {
      writeCloudflareSingletonWorkerReceipt(
        root,
        receipt,
        'singleton-runtime',
        'https://singleton-runtime.account.workers.dev',
      );
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        ...receipt,
        workerName: 'singleton-runtime',
        endpoint: 'https://singleton-runtime.account.workers.dev',
        runtimeToken: 'preserved-token',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses one singleton Worker name for credentialed acceptance', () => {
    expect(activeCloudflareWorkerName({ testPrefix: 'lorepack-ci' })).toBe(
      'lorepack-ci-acceptance-runtime',
    );
  });

  it('selects only stale CI Workers and never the singleton Worker for cleanup', () => {
    expect(
      staleCloudflareWorkerNames(WORKERS_FOR_STALE_CLEANUP, STALE_CI_ENV, OWNERSHIP_RECORDS),
    ).toEqual([`${OLD_PROJECT}-runtime`, `${EARLIER_ATTEMPT_PROJECT}-runtime`]);
  });

  it('does not select Workers for manual runs without CI metadata', () => {
    expect(
      staleCloudflareWorkerNames(
        MANUAL_WORKERS_FOR_STALE_CLEANUP,
        MANUAL_CI_ENV,
        OWNERSHIP_RECORDS,
      ),
    ).toEqual([]);
  });

  it('selects only stale owned catalog and tables databases for cleanup', () => {
    expect(
      staleCloudflareD1DatabaseNames(
        [
          ...OWNERSHIP_RECORDS.flatMap((record) => [
            { name: `${record.projectName}-catalog` },
            { name: `${record.projectName}-tables` },
          ]),
          { name: 'lorepack-ci-100-1-cloudflare-acceptance-catalog' },
          { name: 'lorepack-ci-101-1-cloudflare-acceptance-catalog' },
          { name: 'lorepack-ci-101-2-cloudflare-acceptance-catalog' },
          { name: 'lorepack-ci-102-1-cloudflare-acceptance-catalog' },
          { name: 'lorepack-ci-100-cloudflare-acceptance-catalog' },
          { name: 'other-ci-100-1-cloudflare-acceptance-catalog' },
          { name: 'lorepack-ci-100-1-cloudflare-acceptance-objects' },
        ],
        STALE_CI_ENV,
        OWNERSHIP_RECORDS,
      ),
    ).toEqual([
      `${OLD_PROJECT}-catalog`,
      `${OLD_PROJECT}-tables`,
      `${EARLIER_ATTEMPT_PROJECT}-catalog`,
      `${EARLIER_ATTEMPT_PROJECT}-tables`,
    ]);
  });

  it('does not select D1 databases for manual runs without CI metadata', () => {
    expect(
      staleCloudflareD1DatabaseNames(
        [
          { name: 'lorepack-ci-100-1-cloudflare-acceptance-catalog' },
          { name: `${OLD_PROJECT}-tables` },
        ],
        MANUAL_CI_ENV,
        OWNERSHIP_RECORDS,
      ),
    ).toEqual([]);
  });

  it('selects only stale CI R2 object buckets for cleanup', () => {
    expect(
      staleCloudflareR2BucketNames(R2_BUCKETS_FOR_STALE_CLEANUP, STALE_CI_ENV, OWNERSHIP_RECORDS),
    ).toEqual([`${OLD_PROJECT}-objects`, `${EARLIER_ATTEMPT_PROJECT}-objects`]);
  });

  it('does not select R2 buckets for manual runs without CI metadata', () => {
    expect(
      staleCloudflareR2BucketNames(
        MANUAL_R2_BUCKETS_FOR_STALE_CLEANUP,
        MANUAL_CI_ENV,
        OWNERSHIP_RECORDS,
      ),
    ).toEqual([]);
  });

  it('treats the Cloudflare R2 already-missing response as a tolerated teardown case', () => {
    expect(
      isMissingCloudflareBucketError(
        new Error(
          [
            'wrangler r2 bucket delete lorepack-ci-demo-objects exited 1',
            'A request to the Cloudflare API (/accounts/demo/r2/buckets/lorepack-ci-demo-objects) failed.',
            '',
            '  The specified bucket does not exist. [code: 10006]',
          ].join('\n'),
        ),
      ),
    ).toBe(true);
    expect(
      isMissingCloudflareBucketError(
        new Error('wrangler r2 bucket delete failed for another reason'),
      ),
    ).toBe(false);
  });

  it('recognizes the Cloudflare non-empty bucket response used for retryable teardown', () => {
    expect(
      isNonEmptyCloudflareBucketError(
        new Error(
          [
            'wrangler r2 bucket delete lorepack-ci-demo-objects exited 1',
            'A request to the Cloudflare API (/accounts/demo/r2/buckets/lorepack-ci-demo-objects) failed.',
            '',
            '  The bucket you tried to delete (lorepack-ci-demo-objects) is not empty (account demo). [code: 10008]',
          ].join('\n'),
        ),
      ),
    ).toBe(true);
    expect(
      isNonEmptyCloudflareBucketError(
        new Error('wrangler r2 bucket delete failed for another reason'),
      ),
    ).toBe(false);
  });

  it('treats the Cloudflare D1 already-missing response as a tolerated teardown case', () => {
    expect(
      isMissingCloudflareD1Error(
        new Error(
          [
            'wrangler d1 delete lorepack-ci-demo-catalog --skip-confirmation exited 1',
            "Couldn't find a D1 DB with name or binding 'lorepack-ci-demo-catalog' in your config or the API.",
          ].join('\n'),
        ),
      ),
    ).toBe(true);
    expect(
      isMissingCloudflareD1Error(new Error('wrangler d1 delete failed for another reason')),
    ).toBe(false);
  });

  it('deletes R2 objects against the remote bucket during teardown', () => {
    expect(
      remoteR2ObjectDeleteArgs(
        'lorepack-ci-demo-objects',
        'lorepack-ci-demo/builds/lore_demo/archive.lorepack',
      ),
    ).toEqual([
      'r2',
      'object',
      'delete',
      'lorepack-ci-demo-objects/lorepack-ci-demo/builds/lore_demo/archive.lorepack',
      '--remote',
    ]);
  });

  it('depends on the built CLI binary', () => {
    expect(existsSync(BINARY), `${BINARY} is missing. Run \`pnpm build\` first.`).toBe(true);
  });

  it('includes JSON errors in deploy and resume failures', async () => {
    const project = {
      root: '/tmp/lorepack-cloudflare-smoke',
      projectName: 'Cloudflare Acceptance',
      cleanup() {},
      lore: async () => ({
        code: EXIT_CODES.USER,
        stderr: 'activation progress',
        stdout: JSON.stringify({ error: { message: 'endpoint could not confirm' } }),
      }),
    };
    for (const attempt of [
      deployCloudflareTarget(project, null),
      resumeCloudflareTarget(project, 'receipt', null),
    ]) {
      await expect(attempt).rejects.toThrow('endpoint could not confirm');
      await expect(attempt).rejects.toThrow('activation progress');
    }
  });

  it('includes stdout and stderr when target setup fails', async () => {
    const project = {
      root: '/tmp/lorepack-cloudflare-smoke',
      projectName: 'Cloudflare Acceptance',
      cleanup() {},
      lore: async () => ({
        code: EXIT_CODES.USER,
        stderr: '',
        stdout: JSON.stringify({
          error: {
            code: 'LORE_E_TARGET_NOT_CONFIGURED',
            message: 'Cloudflare resource provisioning failed during target setup.',
            causes: ['bucket name conflict'],
          },
        }),
      }),
    };

    await expect(
      addCloudflareTarget(project, {
        ownership: OWNERSHIP_RECORDS[0],
        accountId: 'acct_123',
        workerName: 'demo-runtime',
        catalogDatabaseName: 'demo-catalog',
        catalogDatabaseId: 'db_123',
        tablesDatabaseName: 'demo-tables',
        tablesDatabaseId: 'tables_123',
        objectsBucketName: 'demo-objects',
        configPath: '/tmp/wrangler.jsonc',
        endpointBase: 'https://demo-runtime.workers.dev',
        wranglerEnv: {},
        runtimeToken: null,
      }),
    ).rejects.toThrow(/stdout:[\s\S]*bucket name conflict/);
  });

  const missing = missingCloudflareTestingEnv(process.env);
  writeCloudflareArtifactSummary(process.env, {
    suite: 'cloudflare-smoke',
    credentialed: missing.length === 0,
    missing,
    note:
      missing.length === 0
        ? 'Cloudflare smoke is configured to run.'
        : `Cloudflare smoke cannot run because credentials are missing: ${missing.join(', ')}`,
  });
  assertRequiredCloudflareTestingEnv(process.env);
  it.skipIf(missing.length > 0)(
    `deploys, redeploys after an edit, and rolls back remotely (missing: ${missing.join(', ') || 'none'})`,
    async () => {
      const project = createCloudflareSmokeProject('Cloudflare Acceptance');
      const buildIds: BuildId[] = [];
      let target: Awaited<ReturnType<typeof provisionCloudflareSmokeTarget>> | undefined;

      try {
        const localBuildId = await buildProject(project);
        buildIds.push(localBuildId);

        target = await provisionCloudflareSmokeTarget(project.projectName);
        target = await addCloudflareTarget(project, target);
        const runtimeToken = await issueCloudflareRuntimeToken(project);

        const deployed = await deployCloudflareTarget(project, runtimeToken);
        expect(deployed.buildId).toBe(localBuildId);

        await waitForRemoteBuild(target.endpointBase, localBuildId, runtimeToken);

        const unauthenticatedBuild = await fetch(`${target.endpointBase}/v1/build`, {
          signal: AbortSignal.timeout(30_000),
        });
        expect(unauthenticatedBuild.status).toBe(401);

        const wrongToken = 'lore_rt_wrong_smoke_token';
        const wrongTokenBuild = await fetch(`${target.endpointBase}/v1/build`, {
          headers: { Authorization: `Bearer ${wrongToken}` },
          signal: AbortSignal.timeout(30_000),
        });
        expect(wrongTokenBuild.status).toBe(401);
        const wrongTokenBody = await wrongTokenBuild.text();
        expect(wrongTokenBody).not.toContain(wrongToken);

        const unauthenticatedMcp = await fetch(`${target.endpointBase}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Mcp-Method': 'tools/list',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
                'io.modelcontextprotocol/clientCapabilities': {},
                'io.modelcontextprotocol/clientInfo': {
                  name: 'cloudflare-auth-smoke',
                  version: '0.0.0',
                },
              },
            },
          }),
          signal: AbortSignal.timeout(30_000),
        });
        expect(unauthenticatedMcp.status).toBe(401);

        const context = await readRemoteContext(target.endpointBase, 'rollback', runtimeToken);
        expect((context as ContextBundle).buildId).toBe(localBuildId);
        expect(context.selected.length + context.overview.length).toBeGreaterThan(0);

        const savedReceipts: Array<{ receipt: unknown; payload: string }> = [];
        for (const captureRequest of [false, true]) {
          const args = {
            task: 'rollback',
            buildId: localBuildId,
            budget: 4000,
            receipt: { captureRequest },
          };
          const response = await fetch(`${target.endpointBase}/v1/context`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${runtimeToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(args),
            signal: AbortSignal.timeout(30_000),
          });
          expect(response.status).toBe(200);
          const payload = await response.text();
          const header = response.headers.get('Lorepack-Context-Receipt');
          expect(header).not.toBeNull();
          const receipt = JSON.parse(Buffer.from(header as string, 'base64url').toString('utf8'));
          expect((await verifyContextReceipt(receipt, payload)).requestRetained).toBe(
            captureRequest,
          );
          savedReceipts.push({ receipt, payload });
          const mcp = await callRemoteMcpTool<ContextBundle>(
            target.endpointBase,
            'lore_context_for_task',
            args,
            runtimeToken,
          );
          const result = mcp.response.result as {
            content: unknown;
            structuredContent: unknown;
            _meta: Record<string, unknown>;
          };
          const mcpPayload = JSON.stringify({
            content: result.content,
            structuredContent: result.structuredContent,
          });
          const mcpReceipt = result._meta['lorepack.dev/context-receipt'];
          expect((await verifyContextReceipt(mcpReceipt, mcpPayload)).buildId).toBe(localBuildId);
          savedReceipts.push({ receipt: mcpReceipt, payload: mcpPayload });
        }

        const firstSearch = await callRemoteMcpTool<SearchResult>(
          target.endpointBase,
          'lore_search',
          {
            query: 'rollback',
            limit: 3,
          },
          runtimeToken,
        );
        expect(firstSearch.structuredContent.buildId).toBe(localBuildId);
        expect(firstSearch.structuredContent.hits.length).toBeGreaterThan(0);
        expect(firstSearch.structuredContent.hits[0]?.locator.relativePath).toBeDefined();

        writeFileSync(
          join(project.root, UNIQUE_FILE),
          `# Phase 6 rollback proof\n\n${UNIQUE_QUERY} appears only in the second deployed build.\n`,
          'utf8',
        );
        const secondBuildId = await buildProject(project);
        buildIds.push(secondBuildId);
        expect(secondBuildId).not.toBe(localBuildId);

        const secondDeploy = await deployCloudflareTarget(project, runtimeToken);
        expect(secondDeploy.buildId).toBe(secondBuildId);
        await waitForRemoteBuild(target.endpointBase, secondBuildId, runtimeToken);

        const secondContext = await readRemoteContext(
          target.endpointBase,
          UNIQUE_QUERY,
          runtimeToken,
        );
        expect(secondContext.buildId).toBe(secondBuildId);
        expect(secondContext.selected.length + secondContext.overview.length).toBeGreaterThan(0);

        const secondSearch = await callRemoteMcpTool<SearchResult>(
          target.endpointBase,
          'lore_search',
          {
            query: UNIQUE_QUERY,
            limit: 3,
          },
          runtimeToken,
        );
        expect(secondSearch.structuredContent.buildId).toBe(secondBuildId);
        expect(secondSearch.structuredContent.hits.length).toBeGreaterThan(0);
        expect(secondSearch.structuredContent.hits[0]?.locator.relativePath).toBe(UNIQUE_FILE);

        for (const saved of savedReceipts) {
          expect((await verifyContextReceipt(saved.receipt, saved.payload)).buildId).toBe(
            localBuildId,
          );
          await expect(
            verifyContextReceipt(saved.receipt, `${saved.payload}\n`),
          ).rejects.toMatchObject({ code: 'LORE_E_SCHEMA_MISMATCH' });
        }

        const rollback = await rollbackCloudflareTarget(project, localBuildId, runtimeToken);
        expect(rollback.buildId).toBe(localBuildId);
        expect(rollback.previousBuildId).toBe(secondBuildId);
        await waitForRemoteBuild(target.endpointBase, localBuildId, runtimeToken);

        const rolledBackContext = await readRemoteContext(
          target.endpointBase,
          'rollback',
          runtimeToken,
        );
        expect(rolledBackContext.buildId).toBe(localBuildId);
        expect(
          rolledBackContext.selected.length + rolledBackContext.overview.length,
        ).toBeGreaterThan(0);

        const rolledBackUniqueSearch = await callRemoteMcpTool<SearchResult>(
          target.endpointBase,
          'lore_search',
          {
            query: UNIQUE_QUERY,
            limit: 3,
          },
          runtimeToken,
        );
        expect(rolledBackUniqueSearch.structuredContent.buildId).toBe(localBuildId);
        expect(rolledBackUniqueSearch.structuredContent.hits).toHaveLength(0);

        const rolledBackRollbackSearch = await callRemoteMcpTool<SearchResult>(
          target.endpointBase,
          'lore_search',
          {
            query: 'rollback',
            limit: 3,
          },
          runtimeToken,
        );
        expect(rolledBackRollbackSearch.structuredContent.buildId).toBe(localBuildId);
        expect(rolledBackRollbackSearch.structuredContent.hits.length).toBeGreaterThan(0);
        await addCloudflareCleanupProbe(target);
      } finally {
        try {
          if (target !== undefined) {
            await teardownCloudflareSmokeTarget(
              target,
              project.projectName,
              project.root,
              buildIds,
            );
          }
        } finally {
          project.cleanup();
        }
      }
    },
    600_000,
  );

  it.skipIf(missing.length > 0)(
    `resumes a forced post-projection Cloudflare deploy without reprojection (missing: ${missing.join(', ') || 'none'})`,
    async () => {
      const project = createCloudflareSmokeProject('Cloudflare Resume');
      const buildIds: BuildId[] = [];
      let target: Awaited<ReturnType<typeof provisionCloudflareSmokeTarget>> | undefined;

      try {
        const buildId = await buildProject(project);
        buildIds.push(buildId);

        target = await provisionCloudflareSmokeTarget(project.projectName);
        target = await addCloudflareTarget(project, target);
        const runtimeToken = await issueCloudflareRuntimeToken(project);

        const forcedFailure = await deployCloudflareTargetExpectFailureAfterProject(
          project,
          runtimeToken,
        );
        expect(forcedFailure.stderr).toContain('Forced test failure after candidate projection.');
        expect(forcedFailure.stderr).toContain(
          `lorepack deploy cloudflare --resume ${forcedFailure.receiptId}`,
        );
        expect(
          existsSync(join(project.root, RECEIPTS_DIRECTORY, `${forcedFailure.receiptId}.json`)),
        ).toBe(true);

        addResumeMutationToken(project.root, buildId, RESUME_MUTATION_QUERY);

        const resumed = await resumeCloudflareTarget(
          project,
          forcedFailure.receiptId,
          runtimeToken,
        );
        expect(resumed.buildId).toBe(buildId);
        expect(resumed.receiptId).toBe(forcedFailure.receiptId);

        await waitForRemoteBuild(target.endpointBase, buildId, runtimeToken);

        const resumedSearch = await callRemoteMcpTool<SearchResult>(
          target.endpointBase,
          'lore_search',
          {
            query: RESUME_MUTATION_QUERY,
            limit: 3,
          },
          runtimeToken,
        );
        expect(resumedSearch.structuredContent.buildId).toBe(buildId);
        expect(resumedSearch.structuredContent.hits).toHaveLength(0);
        await addCloudflareCleanupProbe(target);
      } finally {
        try {
          if (target !== undefined) {
            await teardownCloudflareSmokeTarget(
              target,
              project.projectName,
              project.root,
              buildIds,
            );
          }
        } finally {
          project.cleanup();
        }
      }
    },
    600_000,
  );

  it.skipIf(missing.length > 0)(
    `refuses a build whose capabilities exceed the Cloudflare target (missing: ${missing.join(', ') || 'none'})`,
    async () => {
      const project = createCloudflareSmokeProject('Cloudflare Capability Loss');
      let target: Awaited<ReturnType<typeof provisionCloudflareSmokeTarget>> | undefined;

      try {
        const buildId = await buildProject(project);
        target = await provisionCloudflareSmokeTarget(project.projectName);
        target = await addCloudflareTarget(project, target);
        const runtimeToken = await issueCloudflareRuntimeToken(project);

        addSemanticSearchCapability(project.root, buildId);

        const denied = await project.lore(['deploy', 'cloudflare', '--no-build', '--yes'], {
          LORE_REMOTE_BEARER_TOKEN: runtimeToken,
        });
        expect(denied.code).toBe(EXIT_CODES.REMOTE);
        expect(denied.stderr).toContain('LORE_E_CAPABILITY_LOSS');
        expect(denied.stderr).toContain('semantic-search');
        expect(denied.stderr).toContain('--allow-capability-loss semantic-search');
        expect(existsSync(join(project.root, RECEIPTS_DIRECTORY))).toBe(false);
        await addCloudflareCleanupProbe(target);
      } finally {
        try {
          if (target !== undefined) {
            await teardownCloudflareSmokeTarget(target, project.projectName, project.root, []);
          }
        } finally {
          project.cleanup();
        }
      }
    },
    600_000,
  );
});
