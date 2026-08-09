import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BuildId, ContextBundle } from '@lorepack/core/worker';
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
    lore: async (args) => {
      try {
        const { stdout, stderr } = await execute(
          process.execPath,
          [CLI_BINARY, '--cwd', root, ...args],
          {
            cwd: REPO_ROOT,
            timeout: 600_000,
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, NO_COLOR: '1' },
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

  await runWrangler(['d1', 'create', names.catalogDatabaseName], wranglerEnv);
  const databaseId = await lookupD1DatabaseId(names.catalogDatabaseName, wranglerEnv);
  await runWrangler(['r2', 'bucket', 'create', names.objectsBucketName], wranglerEnv);

  const configPath = join(WORKER_ROOT, `.wrangler-acceptance-${names.workerName}.jsonc`);
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        $schema: './node_modules/wrangler/config-schema.json',
        name: names.workerName,
        main: 'src/worker.ts',
        compatibility_date: COMPATIBILITY_DATE,
        compatibility_flags: ['enable_request_signal'],
        account_id: env.accountId,
        workers_dev: true,
        vars: {
          PROJECT_ID: projectName,
        },
        d1_databases: [
          {
            binding: 'CATALOG_DB',
            database_name: names.catalogDatabaseName,
            database_id: databaseId,
            remote: true,
          },
        ],
        r2_buckets: [
          {
            binding: 'OBJECTS',
            bucket_name: names.objectsBucketName,
            remote: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await runWrangler(['deploy', '--config', configPath], wranglerEnv, WORKER_ROOT);

  return {
    accountId: env.accountId,
    workerName: names.workerName,
    catalogDatabaseName: names.catalogDatabaseName,
    catalogDatabaseId: databaseId,
    objectsBucketName: names.objectsBucketName,
    configPath,
    endpointBase: `https://${names.workerName}.workers.dev`,
    wranglerEnv,
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
  timeoutMs = 120_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${endpointBase}/v1/build`, {
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
): Promise<ContextBundle> {
  const response = await fetch(`${endpointBase}/v1/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
): Promise<McpCallResult<T>> {
  const response = await fetch(`${endpointBase}/mcp`, {
    method: 'POST',
    headers: {
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
): Promise<void> {
  const result = await project.lore([
    '--json',
    'target',
    'add',
    'cloudflare',
    '--yes',
    '--account-id',
    target.accountId,
    '--worker',
    target.workerName,
    '--catalog-db',
    target.catalogDatabaseName,
    '--objects-bucket',
    target.objectsBucketName,
  ]);
  if (result.code !== 0) {
    throw new Error(`lore target add cloudflare failed:\n${result.stderr}`);
  }
}

export async function deployCloudflareTarget(
  project: CloudflareSmokeProject,
): Promise<{ readonly buildId: BuildId; readonly receiptId: string }> {
  const result = await project.lore(['--json', 'deploy', 'cloudflare', '--no-build', '--yes']);
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
