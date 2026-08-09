import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type { BuildId, BuildManifest, ContextBundle } from '@lorepack/core/worker';
import { MCP_PROTOCOL_VERSION } from '@lorepack/mcp';
import { readCloudflareTestingEnv, resourcePrefixFor } from './cloudflare-testing.js';
import { writeMixedCorpus } from './mixed-corpus.js';

const execute = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const WORKER_ROOT = join(REPO_ROOT, 'packages', 'deploy-cloudflare');
const WRANGLER_BIN = join(WORKER_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CLI_BINARY = join(REPO_ROOT, 'packages', 'cli', 'dist', 'entry.js');
const COMPATIBILITY_DATE = '2026-08-08';

export interface CloudflareSmokeProject {
  readonly root: string;
  readonly projectName: string;
  readonly lore: (
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
  cleanup(): void;
}

export interface CloudflareSmokeTarget {
  readonly accountId: string;
  readonly workerName: string;
  readonly catalogDatabaseName: string;
  readonly catalogDatabaseId: string;
  readonly objectsBucketName: string;
  readonly configPath: string;
  readonly endpointBase: string;
  readonly wranglerEnv: Readonly<Record<string, string>>;
  readonly runtimeToken: string | null;
}

export interface McpCallResult<T> {
  readonly response: Record<string, unknown>;
  readonly structuredContent: T;
}

interface CommandOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface D1DatabaseInfo {
  readonly name: string;
  readonly id: string;
}

export function createCloudflareSmokeProject(name: string): CloudflareSmokeProject {
  const root = mkdtempSync(join(tmpdir(), 'lore-cloudflare-acceptance-'));
  const projectName = sanitizeName(name);
  writeFileSync(
    join(root, 'lore.yaml'),
    `version: 1\nname: ${projectName}\nsources:\n  - .\n`,
    'utf8',
  );
  writeMixedCorpus(root);
  return {
    root,
    projectName,
    lore: async (args, env = {}) => {
      try {
        const { stdout, stderr } = await execute(
          process.execPath,
          [CLI_BINARY, '--cwd', root, ...args],
          {
            cwd: REPO_ROOT,
            timeout: 600_000,
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, NO_COLOR: '1', ...env },
          },
        );
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        return {
          code: typeof failure.code === 'number' ? failure.code : 1,
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? '',
        };
      }
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function provisionCloudflareSmokeTarget(
  projectName: string,
): Promise<CloudflareSmokeTarget> {
  const env = readCloudflareTestingEnv(process.env);
  const names = resourceNamesFor(projectName, env);
  const wranglerEnv = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: env.apiToken,
    CLOUDFLARE_ACCOUNT_ID: env.accountId,
    NO_COLOR: '1',
    NO_D1_WARNING: 'true',
  } as Readonly<Record<string, string>>;

  const configPath = join(WORKER_ROOT, `.wrangler-acceptance-${names.workerName}.jsonc`);
  return {
    accountId: env.accountId,
    workerName: names.workerName,
    catalogDatabaseName: names.catalogDatabaseName,
    catalogDatabaseId: '',
    objectsBucketName: names.objectsBucketName,
    configPath,
    endpointBase: `https://${names.workerName}.workers.dev`,
    wranglerEnv,
    runtimeToken: null,
  };
}

export async function teardownCloudflareSmokeTarget(
  target: CloudflareSmokeTarget,
  projectName: string,
  projectRoot: string,
  buildIds: readonly BuildId[],
): Promise<void> {
  const failures: string[] = [];

  for (const key of remoteObjectKeys(projectRoot, projectName, buildIds)) {
    try {
      await runWrangler(
        ['r2', 'object', 'delete', `${target.objectsBucketName}/${key}`],
        target.wranglerEnv,
      );
    } catch (error) {
      failures.push(`delete object ${key}: ${messageOf(error)}`);
    }
  }

  try {
    await runWrangler(['delete', target.workerName, '--force'], target.wranglerEnv, WORKER_ROOT);
  } catch (error) {
    failures.push(`delete worker ${target.workerName}: ${messageOf(error)}`);
  }

  try {
    await runWrangler(['r2', 'bucket', 'delete', target.objectsBucketName], target.wranglerEnv);
  } catch (error) {
    failures.push(`delete bucket ${target.objectsBucketName}: ${messageOf(error)}`);
  }

  try {
    await runWrangler(
      ['d1', 'delete', target.catalogDatabaseName, '--skip-confirmation'],
      target.wranglerEnv,
    );
  } catch (error) {
    failures.push(`delete D1 ${target.catalogDatabaseName}: ${messageOf(error)}`);
  }

  try {
    unlinkSync(target.configPath);
  } catch {}

  if (failures.length > 0) {
    throw new Error(`Cloudflare teardown failed:\n${failures.join('\n')}`);
  }
}

export async function waitForRemoteBuild(
  endpointBase: string,
  buildId: BuildId,
  token: string | null,
  timeoutMs = 120_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${endpointBase}/v1/build`, {
        headers: authHeaders(token),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const payload = (await response.json()) as { readonly buildId?: unknown };
        if (payload.buildId === buildId) return;
      }
    } catch {}
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for ${endpointBase}/v1/build to serve ${buildId}.`);
}

export async function readRemoteContext(
  endpointBase: string,
  task: string,
  token: string | null,
): Promise<ContextBundle> {
  const response = await fetch(`${endpointBase}/v1/context`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ task }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Remote context failed with ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as ContextBundle;
}

export async function callRemoteMcpTool<T>(
  endpointBase: string,
  name: string,
  args: Record<string, unknown>,
  token: string | null,
): Promise<McpCallResult<T>> {
  const response = await fetch(`${endpointBase}/mcp`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': {
            name: 'cloudflare-acceptance',
            version: '0.0.0',
          },
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Remote MCP ${name} failed with ${response.status}: ${await response.text()}`);
  }

  const payload = decodeMcpPayload(await response.text());
  const result = payload.result as { structuredContent?: unknown } | undefined;
  if (result?.structuredContent === undefined) {
    throw new Error(`Remote MCP ${name} returned no structuredContent.`);
  }

  return {
    response: payload,
    structuredContent: result.structuredContent as T,
  };
}

export async function buildProject(project: CloudflareSmokeProject): Promise<BuildId> {
  const result = await project.lore(['--json', 'build']);
  if (result.code !== 0) {
    throw new Error(`lore build failed:\n${result.stderr}`);
  }
  const payload = JSON.parse(result.stdout) as { readonly buildId?: unknown };
  if (!isBuildId(payload.buildId)) {
    throw new Error(`lore build returned no build id:\n${result.stdout}`);
  }
  return payload.buildId;
}

export async function addCloudflareTarget(
  project: CloudflareSmokeProject,
  target: CloudflareSmokeTarget,
): Promise<CloudflareSmokeTarget> {
  const result = await project.lore(
    ['--json', 'target', 'add', 'cloudflare', '--yes'],
    target.wranglerEnv,
  );
  if (result.code !== 0) {
    throw new Error(`lore target add cloudflare failed:\n${result.stderr}`);
  }

  const databaseId = await lookupD1DatabaseId(target.catalogDatabaseName, target.wranglerEnv);
  const configuredTarget = {
    ...target,
    catalogDatabaseId: databaseId,
  };
  await deployAcceptanceWorker(configuredTarget, project.projectName);
  return configuredTarget;
}

export async function deployCloudflareTarget(
  project: CloudflareSmokeProject,
  token: string | null,
  options: { readonly failAfterProject?: boolean } = {},
): Promise<{ readonly buildId: BuildId; readonly receiptId: string }> {
  const result = await project.lore(['--json', 'deploy', 'cloudflare', '--no-build', '--yes'], {
    ...runtimeTokenEnv(token),
    ...(options.failAfterProject === true
      ? {
          LORE_TEST_ALLOW_HOOKS: '1',
          LORE_TEST_FAIL_DEPLOY_AFTER_PROJECT: '1',
        }
      : {}),
  });
  if (result.code !== 0) {
    throw new Error(`lore deploy cloudflare failed:\n${result.stderr}`);
  }
  const payload = JSON.parse(result.stdout) as {
    readonly buildId?: unknown;
    readonly receiptId?: unknown;
  };
  if (!isBuildId(payload.buildId) || typeof payload.receiptId !== 'string') {
    throw new Error(`lore deploy cloudflare returned an unreadable receipt:\n${result.stdout}`);
  }
  return { buildId: payload.buildId, receiptId: payload.receiptId };
}

export async function deployCloudflareTargetExpectFailureAfterProject(
  project: CloudflareSmokeProject,
  token: string | null,
): Promise<{ readonly receiptId: string; readonly stderr: string }> {
  const before = new Set(listReceiptIds(project.root));
  const result = await project.lore(['deploy', 'cloudflare', '--no-build', '--yes'], {
    ...runtimeTokenEnv(token),
    LORE_TEST_ALLOW_HOOKS: '1',
    LORE_TEST_FAIL_DEPLOY_AFTER_PROJECT: '1',
  });
  if (result.code === 0) {
    throw new Error('lore deploy cloudflare unexpectedly succeeded under the failure hook.');
  }
  const after = listReceiptIds(project.root).filter((receiptId) => !before.has(receiptId));
  if (after.length !== 1) {
    throw new Error(
      `Expected exactly one new receipt after the forced failure, found ${after.length}.`,
    );
  }
  return { receiptId: after[0] as string, stderr: result.stderr };
}

export async function resumeCloudflareTarget(
  project: CloudflareSmokeProject,
  receiptId: string,
  token: string | null,
): Promise<{ readonly buildId: BuildId; readonly receiptId: string }> {
  const result = await project.lore(
    ['--json', 'deploy', 'cloudflare', '--no-build', '--yes', '--resume', receiptId],
    runtimeTokenEnv(token),
  );
  if (result.code !== 0) {
    throw new Error(`lore deploy cloudflare --resume ${receiptId} failed:\n${result.stderr}`);
  }
  const payload = JSON.parse(result.stdout) as {
    readonly buildId?: unknown;
    readonly receiptId?: unknown;
  };
  if (!isBuildId(payload.buildId) || typeof payload.receiptId !== 'string') {
    throw new Error(
      `lore deploy cloudflare --resume ${receiptId} returned an unreadable receipt:\n${result.stdout}`,
    );
  }
  return { buildId: payload.buildId, receiptId: payload.receiptId };
}

export async function rollbackCloudflareTarget(
  project: CloudflareSmokeProject,
  buildId: BuildId,
  token: string | null,
): Promise<{
  readonly buildId: BuildId;
  readonly previousBuildId: BuildId | null;
  readonly confirmedBuildId: BuildId | null;
}> {
  const result = await project.lore(
    ['--json', 'rollback', '--target', 'cloudflare', buildId],
    runtimeTokenEnv(token),
  );
  if (result.code !== 0) {
    throw new Error(`lore rollback --target cloudflare failed:\n${result.stderr}`);
  }
  const payload = JSON.parse(result.stdout) as {
    readonly buildId?: unknown;
    readonly previousBuildId?: unknown;
    readonly confirmedBuildId?: unknown;
  };
  if (!isBuildId(payload.buildId)) {
    throw new Error(`lore rollback --target cloudflare returned no build id:\n${result.stdout}`);
  }
  return {
    buildId: payload.buildId,
    previousBuildId: isBuildId(payload.previousBuildId) ? payload.previousBuildId : null,
    confirmedBuildId: isBuildId(payload.confirmedBuildId) ? payload.confirmedBuildId : null,
  };
}

export async function issueCloudflareRuntimeToken(
  project: CloudflareSmokeProject,
  rotate = false,
): Promise<string> {
  const result = await project.lore([
    '--json',
    'target',
    'token',
    'cloudflare',
    ...(rotate ? ['--rotate'] : []),
  ]);
  if (result.code !== 0) {
    throw new Error(`lore target token cloudflare failed:\n${result.stderr}`);
  }
  const payload = JSON.parse(result.stdout) as { readonly token?: unknown };
  if (typeof payload.token !== 'string' || payload.token.trim() === '') {
    throw new Error(`lore target token cloudflare returned no token:\n${result.stdout}`);
  }
  return payload.token;
}

export function addSemanticSearchCapability(projectRoot: string, buildId: BuildId): void {
  const manifestPath = join(projectRoot, '.lore', 'builds', buildId, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuildManifest;
  if (!manifest.capabilities.includes('semantic-search')) {
    manifest.capabilities = [...manifest.capabilities, 'semantic-search'];
  }
  manifest.embeddingProfile ??= {
    modelId: 'acceptance-smoke',
    revision: '1',
    tokenizer: 'acceptance-smoke',
    pooling: 'mean',
    normalized: true,
    dimensions: 3,
    valueType: 'float32',
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function addResumeMutationToken(projectRoot: string, buildId: BuildId, token: string): void {
  const databasePath = join(projectRoot, '.lore', 'builds', buildId, 'context.sqlite');
  const db = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    const row = db.prepare('SELECT id, text FROM chunks ORDER BY id LIMIT 1').get() as
      | { readonly id: string; readonly text: string }
      | undefined;
    if (row === undefined) {
      throw new Error(`Build ${buildId} has no chunks to mutate for resume verification.`);
    }
    const mutated = `${row.text}\n${token}`;
    db.prepare('UPDATE chunks SET text = ? WHERE id = ?').run(mutated, row.id);
    db.prepare('UPDATE chunks_fts SET body = ? WHERE chunk_id = ?').run(mutated, row.id);
  } finally {
    db.close();
  }
}

function resourceNamesFor(
  projectName: string,
  env: ReturnType<typeof readCloudflareTestingEnv>,
): {
  readonly workerName: string;
  readonly catalogDatabaseName: string;
  readonly objectsBucketName: string;
} {
  const stable = sanitizeName(resourcePrefixFor(env));
  const unique =
    env.runId === null
      ? sanitizeName(`local-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
      : 'ci';
  const base = sanitizeName(`${stable}-${unique}-${projectName}`);
  return {
    workerName: withSuffix(base, 'runtime', 63),
    catalogDatabaseName: withSuffix(base, 'catalog', 63),
    objectsBucketName: withSuffix(base, 'objects', 63),
  };
}

function listReceiptIds(projectRoot: string): readonly string[] {
  const receiptsRoot = join(projectRoot, '.lore', 'receipts');
  try {
    return readdirSync(receiptsRoot)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

async function lookupD1DatabaseId(
  name: string,
  env: Readonly<Record<string, string>>,
): Promise<string> {
  const listed = await runWrangler(['d1', 'list', '--json'], env);
  const parsed = JSON.parse(listed.stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`wrangler d1 list returned unexpected JSON:\n${listed.stdout}`);
  }
  const match = parsed
    .map(parseD1DatabaseInfo)
    .find((database): database is D1DatabaseInfo => database !== null && database.name === name);
  if (match === undefined) {
    throw new Error(`Could not find D1 database ${name} in wrangler d1 list output.`);
  }
  return match.id;
}

async function deployAcceptanceWorker(
  target: CloudflareSmokeTarget,
  projectName: string,
): Promise<void> {
  writeFileSync(
    target.configPath,
    `${JSON.stringify(
      {
        $schema: './node_modules/wrangler/config-schema.json',
        name: target.workerName,
        main: 'src/worker.ts',
        compatibility_date: COMPATIBILITY_DATE,
        compatibility_flags: ['enable_request_signal'],
        account_id: target.accountId,
        workers_dev: true,
        vars: {
          PROJECT_ID: projectName,
        },
        d1_databases: [
          {
            binding: 'CATALOG_DB',
            database_name: target.catalogDatabaseName,
            database_id: target.catalogDatabaseId,
            remote: true,
          },
        ],
        r2_buckets: [
          {
            binding: 'OBJECTS',
            bucket_name: target.objectsBucketName,
            remote: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await runWrangler(['deploy', '--config', target.configPath], target.wranglerEnv, WORKER_ROOT);
}

function parseD1DatabaseInfo(value: unknown): D1DatabaseInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const name = typeof row.name === 'string' ? row.name : null;
  const idFields = [row.uuid, row.id, row.database_id];
  const id =
    idFields.find((candidate): candidate is string => typeof candidate === 'string') ?? null;
  return name === null || id === null ? null : { name, id };
}

async function runWrangler(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd = REPO_ROOT,
): Promise<CommandOutput> {
  try {
    const { stdout, stderr } = await execute(process.execPath, [WRANGLER_BIN, ...args], {
      cwd,
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    throw new Error(
      [
        `wrangler ${args.join(' ')} exited ${typeof failure.code === 'number' ? failure.code : 1}`,
        failure.stderr ?? '',
        failure.stdout ?? '',
      ]
        .filter((line) => line.trim() !== '')
        .join('\n'),
    );
  }
}

function remoteObjectKeys(
  projectRoot: string,
  projectName: string,
  buildIds: readonly BuildId[],
): readonly string[] {
  const hashes = listObjectHashes(join(projectRoot, '.lore', 'objects', 'sha256'));
  const keys = new Set<string>();
  for (const buildId of buildIds) {
    keys.add(`${projectName}/builds/${buildId}/archive.lorepack`);
  }
  for (const hash of hashes) {
    keys.add(
      `${projectName}/objects/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`,
    );
  }
  return [...keys];
}

function listObjectHashes(root: string): readonly string[] {
  try {
    const first = readdirSync(root, { withFileTypes: true });
    const hashes: string[] = [];
    for (const one of first) {
      if (!one.isDirectory()) continue;
      const firstPath = join(root, one.name);
      for (const two of readdirSync(firstPath, { withFileTypes: true })) {
        if (!two.isDirectory()) continue;
        const secondPath = join(firstPath, two.name);
        for (const leaf of readdirSync(secondPath, { withFileTypes: true })) {
          if (!leaf.isFile()) continue;
          hashes.push(`${one.name}${two.name}${leaf.name}`);
        }
      }
    }
    return hashes;
  } catch {
    return [];
  }
}

function decodeMcpPayload(raw: string): Record<string, unknown> {
  const payload = raw.startsWith('event:')
    ? (raw.split('\n').find((line) => line.startsWith('data: ')) ?? '').slice('data: '.length)
    : raw;
  return JSON.parse(payload) as Record<string, unknown>;
}

function sanitizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');
}

function withSuffix(base: string, suffix: string, limit: number): string {
  const tail = `-${suffix}`;
  const head = base.slice(0, Math.max(1, limit - tail.length)).replace(/-+$/g, '');
  return `${head}${tail}`;
}

function isBuildId(value: unknown): value is BuildId {
  return typeof value === 'string' && /^lore_[0-9a-f]{64}$/.test(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders(token: string | null): Record<string, string> {
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

function runtimeTokenEnv(token: string | null): Readonly<Record<string, string>> {
  return token === null ? {} : { LORE_REMOTE_BEARER_TOKEN: token };
}
