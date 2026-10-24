import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type { BuildId, BuildManifest, ContextBundle } from '@lorepack/core/worker';
import { MCP_PROTOCOL_VERSION } from '@lorepack/mcp';
import {
  type CloudflareOwnershipRecord,
  type CloudflareOwnershipScope,
  cloudflareOwnershipKey,
  cloudflareOwnershipNames,
  OWNERSHIP_KEY_PREFIX,
  readCloudflareOwnershipRecord,
  staleCloudflareOwnershipRecords,
} from './cloudflare_ownership.js';
import {
  cloudflareArtifactDirectory,
  missingCloudflareTestingEnv,
  readCloudflareTestingEnv,
  redactCloudflareSecrets,
} from './cloudflare-testing.js';
import { writeMixedCorpus } from './mixed-corpus.js';

const execute = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const WORKER_ROOT = join(REPO_ROOT, 'packages', 'deploy-cloudflare');
const WRANGLER_BIN = join(WORKER_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
// This smoke test exercises the workspace Cloudflare adapter, whose pinned
// Wrangler dependency is intentionally not part of the public CLI bundle.
const CLI_BINARY = join(REPO_ROOT, 'packages', 'cli', 'dist', 'entry.js');
const COMPATIBILITY_DATE = '2026-08-08';
const WORKER_DEPLOY_ATTEMPTS = 3;
const WORKER_PROPAGATION_DELAY_MS = 2_000;
const D1_DELETE_ATTEMPTS = 3;
const D1_DELETE_RETRY_DELAY_MS = 500;
const R2_GET_ATTEMPTS = 4;
const R2_GET_RETRY_DELAY_MS = 500;
const R2_GET_MAX_RETRY_AFTER_MS = 30_000;
let artifactSequence = 0;

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
  readonly ownership: CloudflareOwnershipRecord;
  readonly accountId: string;
  readonly workerName: string;
  readonly catalogDatabaseName: string;
  readonly catalogDatabaseId: string;
  readonly tablesDatabaseName: string;
  readonly tablesDatabaseId: string;
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

interface CloudflareWorkerInfo {
  readonly name: string;
}

interface CloudflareTargetReceiptJson {
  readonly accountId: string;
  readonly workerName: string;
  readonly catalogDatabaseName: string;
  readonly tablesDatabaseName: string;
  readonly objectsBucketName: string;
}

interface WranglerDeploymentInfo {
  readonly endpointBase: string;
}

export function createCloudflareSmokeProject(name: string): CloudflareSmokeProject {
  const root = mkdtempSync(join(tmpdir(), 'lore-cloudflare-acceptance-'));
  const projectName = smokeProjectName(name, process.env);
  const artifactsRoot = cloudflareArtifactDirectory(process.env);
  const artifactDirectory =
    artifactsRoot === null ? null : join(artifactsRoot, sanitizeName(projectName));
  let commandSequence = 0;
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
      const command = [CLI_BINARY, '--cwd', root, ...args];
      const commandEnv = { ...process.env, NO_COLOR: '1', ...env };
      const result = await execCommand(command, {
        cwd: REPO_ROOT,
        timeout: 600_000,
        maxBuffer: 64 * 1024 * 1024,
        env: commandEnv,
      });
      if (artifactDirectory !== null) {
        commandSequence += 1;
        writeCommandArtifact(
          artifactDirectory,
          commandSequence,
          'lorepack',
          args,
          result,
          commandEnv,
        );
      }
      return result;
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

  const ownership = readCloudflareOwnershipRecord({ ...env, formatVersion: 1, projectName }, env);
  await ensureCloudflareOwnershipBucket(env, wranglerEnv);
  await cleanupOwnedCloudflareResources(env, wranglerEnv);
  await assertCloudflareNamesUnused(ownership, wranglerEnv);
  await writeCloudflareOwnership(ownership, wranglerEnv);

  const configPath = join(WORKER_ROOT, `.wrangler-acceptance-${names.workerName}.jsonc`);
  return {
    ownership,
    accountId: env.accountId,
    workerName: names.workerName,
    catalogDatabaseName: names.catalogDatabaseName,
    catalogDatabaseId: '',
    tablesDatabaseName: names.tablesDatabaseName,
    tablesDatabaseId: '',
    objectsBucketName: names.objectsBucketName,
    configPath,
    endpointBase: `https://${names.workerName}.workers.dev`,
    wranglerEnv,
    runtimeToken: null,
  };
}

async function verifyCloudflareSmokeTarget(target: CloudflareSmokeTarget, projectName: string) {
  const scope = readCloudflareTestingEnv(target.wranglerEnv);
  const ownership = await readCloudflareOwnership(
    cloudflareOwnershipBucketName(scope),
    cloudflareOwnershipKey(target.ownership),
    scope,
    target.wranglerEnv,
  );
  const ownedNames = cloudflareOwnershipNames(ownership);
  if (
    ownership.projectName !== projectName ||
    ownership.runId !== scope.runId ||
    ownership.runAttempt !== scope.runAttempt ||
    target.accountId !== ownership.accountId ||
    target.catalogDatabaseName !== ownedNames.catalogDatabaseName ||
    target.tablesDatabaseName !== ownedNames.tablesDatabaseName ||
    target.objectsBucketName !== ownedNames.objectsBucketName ||
    target.workerName !== activeCloudflareWorkerName(scope)
  ) {
    throw new Error('Cloudflare teardown target does not match its recorded ownership.');
  }
  return { scope, ownership, ownedNames };
}

export async function addCloudflareCleanupProbe(target: CloudflareSmokeTarget): Promise<void> {
  await verifyCloudflareSmokeTarget(target, target.ownership.projectName);
  const directory = mkdtempSync(join(tmpdir(), 'lore-cloudflare-cleanup-probe-'));
  try {
    const file = join(directory, 'probe.txt');
    writeFileSync(file, 'Owned acceptance cleanup probe.\n', { mode: 0o600 });
    await runWrangler(
      [
        'r2',
        'object',
        'put',
        `${target.objectsBucketName}/acceptance-cleanup-probe`,
        '--file',
        file,
        '--content-type',
        'text/plain',
        '--remote',
      ],
      target.wranglerEnv,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function teardownCloudflareSmokeTarget(
  target: CloudflareSmokeTarget,
  projectName: string,
  projectRoot: string,
  buildIds: readonly BuildId[],
): Promise<void> {
  const { scope, ownership, ownedNames } = await verifyCloudflareSmokeTarget(target, projectName);
  const artifactsRoot = cloudflareArtifactDirectory(process.env);
  const artifactDirectory =
    artifactsRoot === null ? null : join(artifactsRoot, sanitizeName(projectName));
  const failures: string[] = [];

  if (artifactDirectory !== null) {
    mkdirSync(artifactDirectory, { recursive: true });
    const receiptsRoot = join(projectRoot, '.lore', 'receipts');
    if (existsSync(receiptsRoot)) {
      cpSync(receiptsRoot, join(artifactDirectory, 'receipts'), { recursive: true });
    }
    writeFileSync(
      join(artifactDirectory, 'remote-summary.json'),
      `${JSON.stringify(
        {
          projectName,
          workerName: target.workerName,
          endpointBase: target.endpointBase,
          catalogDatabaseName: target.catalogDatabaseName,
          tablesDatabaseName: target.tablesDatabaseName,
          objectsBucketName: target.objectsBucketName,
          buildIds,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  for (const key of remoteObjectKeys(projectRoot, projectName, buildIds)) {
    try {
      await runWrangler(
        remoteR2ObjectDeleteArgs(target.objectsBucketName, key),
        target.wranglerEnv,
      );
    } catch (error) {
      failures.push(`delete object ${key}: ${messageOf(error)}`);
    }
  }

  try {
    await deleteCloudflareWorker(target);
  } catch (error) {
    failures.push(`delete worker ${target.workerName}: ${messageOf(error)}`);
  }
  try {
    await deleteCloudflareWorkerByName(target.accountId, ownedNames.workerName, target.wranglerEnv);
  } catch (error) {
    failures.push(`delete worker ${ownedNames.workerName}: ${messageOf(error)}`);
  }

  try {
    await deleteCloudflareBucket(target.objectsBucketName, target.wranglerEnv);
  } catch (error) {
    if (!isMissingCloudflareBucketError(error)) {
      failures.push(`delete bucket ${target.objectsBucketName}: ${messageOf(error)}`);
    }
  }

  try {
    await deleteCloudflareD1Database(target.catalogDatabaseName, target.wranglerEnv);
  } catch (error) {
    if (!isMissingCloudflareD1Error(error)) {
      failures.push(`delete D1 ${target.catalogDatabaseName}: ${messageOf(error)}`);
    }
  }

  try {
    await deleteCloudflareD1Database(target.tablesDatabaseName, target.wranglerEnv);
  } catch (error) {
    if (!isMissingCloudflareD1Error(error)) {
      failures.push(`delete D1 ${target.tablesDatabaseName}: ${messageOf(error)}`);
    }
  }

  try {
    unlinkSync(target.configPath);
  } catch {}

  if (failures.length > 0) {
    throw new Error(`Cloudflare teardown failed:\n${failures.join('\n')}`);
  }
  await runWrangler(
    remoteR2ObjectDeleteArgs(
      cloudflareOwnershipBucketName(scope),
      cloudflareOwnershipKey(ownership),
    ),
    target.wranglerEnv,
  );
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
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
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
    throw new Error(`lorepack build failed:\n${result.stderr}`);
  }
  const payload = JSON.parse(result.stdout) as { readonly buildId?: unknown };
  if (!isBuildId(payload.buildId)) {
    throw new Error(`lorepack build returned no build id:\n${result.stdout}`);
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
    throw new Error(`lorepack target add cloudflare failed:\n${commandFailureOutput(result)}`);
  }

  const receipt = parseCloudflareTargetReceipt(result.stdout);
  const singletonReceipt = { ...receipt, workerName: target.workerName };
  const configuredNames = {
    ...target,
    accountId: singletonReceipt.accountId,
    workerName: singletonReceipt.workerName,
    catalogDatabaseName: singletonReceipt.catalogDatabaseName,
    tablesDatabaseName: singletonReceipt.tablesDatabaseName,
    objectsBucketName: singletonReceipt.objectsBucketName,
    configPath: join(WORKER_ROOT, `.wrangler-acceptance-${singletonReceipt.workerName}.jsonc`),
    endpointBase: `https://${singletonReceipt.workerName}.workers.dev`,
  };
  const databaseId = await lookupD1DatabaseId(
    configuredNames.catalogDatabaseName,
    configuredNames.wranglerEnv,
  );
  const tablesDatabaseId = await lookupD1DatabaseId(
    configuredNames.tablesDatabaseName,
    configuredNames.wranglerEnv,
  );
  const configuredTarget = {
    ...configuredNames,
    catalogDatabaseId: databaseId,
    tablesDatabaseId,
  };
  const deployed = await deployAcceptanceWorker(configuredTarget, project.projectName);
  writeCloudflareSingletonWorkerReceipt(
    project.root,
    receipt,
    target.workerName,
    deployed.endpointBase,
  );
  return {
    ...configuredTarget,
    endpointBase: deployed.endpointBase,
  };
}

function commandFailureOutput(result: CommandOutput): string {
  return [
    `exit code: ${result.code}`,
    result.stderr.trim() === '' ? 'stderr: <empty>' : `stderr:\n${result.stderr.trimEnd()}`,
    result.stdout.trim() === '' ? 'stdout: <empty>' : `stdout:\n${result.stdout.trimEnd()}`,
  ].join('\n');
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
    throw new Error(`lorepack deploy cloudflare failed:\n${commandFailureOutput(result)}`);
  }
  const payload = JSON.parse(result.stdout) as {
    readonly buildId?: unknown;
    readonly receiptId?: unknown;
  };
  if (!isBuildId(payload.buildId) || typeof payload.receiptId !== 'string') {
    throw new Error(`lorepack deploy cloudflare returned an unreadable receipt:\n${result.stdout}`);
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
    throw new Error('lorepack deploy cloudflare unexpectedly succeeded under the failure hook.');
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
    throw new Error(
      `lorepack deploy cloudflare --resume ${receiptId} failed:\n${commandFailureOutput(result)}`,
    );
  }
  const payload = JSON.parse(result.stdout) as {
    readonly buildId?: unknown;
    readonly receiptId?: unknown;
  };
  if (!isBuildId(payload.buildId) || typeof payload.receiptId !== 'string') {
    throw new Error(
      `lorepack deploy cloudflare --resume ${receiptId} returned an unreadable receipt:\n${result.stdout}`,
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
    throw new Error(`lorepack rollback --target cloudflare failed:\n${result.stderr}`);
  }
  const payload = JSON.parse(result.stdout) as {
    readonly buildId?: unknown;
    readonly previousBuildId?: unknown;
    readonly confirmedBuildId?: unknown;
  };
  if (!isBuildId(payload.buildId)) {
    throw new Error(
      `lorepack rollback --target cloudflare returned no build id:\n${result.stdout}`,
    );
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
    throw new Error(`lorepack target token cloudflare failed:\n${result.stderr}`);
  }
  const payload = JSON.parse(result.stdout) as { readonly token?: unknown };
  if (typeof payload.token !== 'string' || payload.token.trim() === '') {
    throw new Error(`lorepack target token cloudflare returned no token:\n${result.stdout}`);
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
  env: { readonly testPrefix: string },
): {
  readonly workerName: string;
  readonly catalogDatabaseName: string;
  readonly tablesDatabaseName: string;
  readonly objectsBucketName: string;
} {
  return {
    workerName: activeCloudflareWorkerName(env),
    catalogDatabaseName: withSuffix(projectName, 'catalog', 63),
    tablesDatabaseName: withSuffix(projectName, 'tables', 63),
    objectsBucketName: withSuffix(projectName, 'objects', 63),
  };
}

export function activeCloudflareWorkerName(env: { readonly testPrefix: string }): string {
  return withSuffix(sanitizeName(env.testPrefix), 'acceptance-runtime', 63);
}

export function writeCloudflareSingletonWorkerReceipt(
  projectRoot: string,
  receipt: CloudflareTargetReceiptJson,
  workerName: string,
  endpointBase: string,
): CloudflareTargetReceiptJson {
  const path = join(projectRoot, '.lore', 'targets', 'cloudflare.json');
  const fullReceipt = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const patched = { ...receipt, workerName };
  writeFileSync(
    path,
    `${JSON.stringify({ ...fullReceipt, workerName, endpoint: endpointBase }, null, 2)}\n`,
    'utf8',
  );
  return patched;
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
): Promise<WranglerDeploymentInfo> {
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
          {
            binding: 'TABLES_DB',
            database_name: target.tablesDatabaseName,
            database_id: target.tablesDatabaseId,
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
        // The deployed Worker refuses table queries without it (#558).
        ratelimits: [
          {
            name: 'TABLE_QUERY_LIMITER',
            namespace_id: '1558',
            simple: { limit: 20, period: 60 },
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  for (let attempt = 1; attempt <= WORKER_DEPLOY_ATTEMPTS; attempt += 1) {
    try {
      const deployed = await runWrangler(
        ['deploy', '--config', target.configPath],
        target.wranglerEnv,
        WORKER_ROOT,
      );
      return parseWranglerDeploymentInfo(deployed.stdout, target.workerName);
    } catch (error) {
      if (!isCloudflareWorkerPropagationError(error) || attempt === WORKER_DEPLOY_ATTEMPTS) {
        throw error;
      }
      await delay(WORKER_PROPAGATION_DELAY_MS * attempt);
    }
  }

  throw new Error('Cloudflare Worker deployment exhausted its retry attempts.');
}

export function isCloudflareWorkerPropagationError(error: unknown): boolean {
  const message = messageOf(error);
  const worker = message.match(/\/accounts\/[^/\s)]+\/workers\/workers\/([^/\s)]+)\)/);
  const postUpload = worker !== null && message.includes(`Uploaded ${worker[1]} (`);
  const legacySubdomain = message.includes('/workers/scripts/') && message.includes('/subdomain');
  return (
    (legacySubdomain || postUpload) &&
    message.includes('This Worker does not exist on your account.') &&
    message.includes('[code: 10007]')
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function staleOwnedNames(
  env: CloudflareOwnershipScope,
  records: readonly CloudflareOwnershipRecord[],
  fields: readonly (keyof ReturnType<typeof cloudflareOwnershipNames>)[],
): ReadonlySet<string> {
  return new Set(
    staleCloudflareOwnershipRecords(records, env).flatMap((record) => {
      const names = cloudflareOwnershipNames(record);
      return fields.map((field) => names[field]);
    }),
  );
}

export function staleCloudflareD1DatabaseNames(
  databases: readonly { readonly name: string }[],
  env: CloudflareOwnershipScope,
  records: readonly CloudflareOwnershipRecord[],
): readonly string[] {
  const owned = staleOwnedNames(env, records, ['catalogDatabaseName', 'tablesDatabaseName']);
  return databases
    .filter(({ name }) => owned.has(name))
    .map(({ name }) => name)
    .sort();
}

export function staleCloudflareWorkerNames(
  workers: readonly { readonly name: string }[],
  env: CloudflareOwnershipScope,
  records: readonly CloudflareOwnershipRecord[],
): readonly string[] {
  const owned = staleOwnedNames(env, records, ['workerName']);
  return workers
    .filter(({ name }) => name !== activeCloudflareWorkerName(env) && owned.has(name))
    .map(({ name }) => name)
    .sort();
}

export function staleCloudflareR2BucketNames(
  buckets: readonly { readonly name: string }[],
  env: CloudflareOwnershipScope,
  records: readonly CloudflareOwnershipRecord[],
): readonly string[] {
  const owned = staleOwnedNames(env, records, ['objectsBucketName']);
  return buckets
    .filter(({ name }) => owned.has(name))
    .map(({ name }) => name)
    .sort();
}

export function cloudflareOwnershipBucketName(env: { readonly testPrefix: string }): string {
  return `${sanitizeName(env.testPrefix)}-acceptance-ledger`;
}

async function ensureCloudflareOwnershipBucket(
  scope: CloudflareOwnershipScope,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  const name = cloudflareOwnershipBucketName(scope);
  if (!(await cloudflareBucketExists(name, scope.accountId, env))) {
    await runWrangler(['r2', 'bucket', 'create', name], env);
  }
}

async function cloudflareBucketExists(
  name: string,
  accountId: string,
  env: Readonly<Record<string, string>>,
): Promise<boolean> {
  try {
    const value = await cloudflareR2Json(
      new URL(
        `${cloudflareR2BucketListUrl(encodeURIComponent(accountId))}/${encodeURIComponent(name)}`,
      ),
      'GET',
      env,
    );
    const bucket = (value as { result?: { name?: unknown } }).result;
    if (bucket?.name !== name)
      throw new Error('Cloudflare bucket metadata names a different bucket.');
    return true;
  } catch (error) {
    if (isMissingCloudflareBucketError(error)) return false;
    throw error;
  }
}

async function assertCloudflareNamesUnused(
  record: CloudflareOwnershipRecord,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  const names = cloudflareOwnershipNames(record);
  const workers = await listCloudflareWorkers(record.accountId, env);
  const databases = parseD1DatabaseList((await runWrangler(['d1', 'list', '--json'], env)).stdout);
  if (
    workers.some(({ name }) => name === names.workerName) ||
    databases.some(
      ({ name }) => name === names.catalogDatabaseName || name === names.tablesDatabaseName,
    ) ||
    (await cloudflareBucketExists(names.objectsBucketName, record.accountId, env))
  ) {
    throw new Error('Refuse to record ownership of existing Cloudflare resources.');
  }
}

async function writeCloudflareOwnership(
  record: CloudflareOwnershipRecord,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'lore-cloudflare-ownership-'));
  try {
    const file = join(directory, 'ownership.json');
    writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await runWrangler(
      [
        'r2',
        'object',
        'put',
        `${cloudflareOwnershipBucketName(record)}/${cloudflareOwnershipKey(record)}`,
        '--file',
        file,
        '--content-type',
        'application/json',
        '--remote',
      ],
      env,
    );
    const artifacts = cloudflareArtifactDirectory(env);
    if (artifacts !== null) {
      const destination = join(artifacts, record.projectName);
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, 'ownership-record.json'), `${JSON.stringify(record)}\n`, {
        mode: 0o600,
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function readCloudflareOwnership(
  bucket: string,
  key: string,
  scope: CloudflareOwnershipScope,
  env: Readonly<Record<string, string>>,
): Promise<CloudflareOwnershipRecord> {
  if (!/^ownership\/v1\/lpci-[a-f0-9]{32}\.json$/.test(key)) {
    throw new Error('Cloudflare ownership listing returned an invalid record key.');
  }
  const base = `${cloudflareR2BucketListUrl(encodeURIComponent(scope.accountId))}/${encodeURIComponent(bucket)}`;
  const response = await fetch(`${base}/objects/${key}`, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Cloudflare ownership record read failed (${response.status}).`);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error('Cloudflare ownership record is not valid JSON.');
  }
  const record = readCloudflareOwnershipRecord(value, scope);
  if (cloudflareOwnershipKey(record) !== key) {
    throw new Error('Cloudflare ownership record does not match its stored key.');
  }
  return record;
}

export async function cleanupOwnedCloudflareResources(
  scope: CloudflareOwnershipScope,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  if (scope.accountId !== env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('Cloudflare cleanup account does not match its ownership scope.');
  }
  const actual = readCloudflareTestingEnv(env);
  if (
    scope.testPrefix !== actual.testPrefix ||
    scope.runId !== actual.runId ||
    scope.runAttempt !== actual.runAttempt
  ) {
    throw new Error('Cloudflare cleanup scope does not match the current environment.');
  }
  if (scope.runId === null || scope.runAttempt === null) return;
  const bucket = cloudflareOwnershipBucketName(scope);
  const keys = await listCloudflareBucketObjectKeys(bucket, env, OWNERSHIP_KEY_PREFIX);
  const records: CloudflareOwnershipRecord[] = [];
  for (const key of keys) records.push(await readCloudflareOwnership(bucket, key, scope, env));
  for (const record of staleCloudflareOwnershipRecords(records, scope)) {
    const names = cloudflareOwnershipNames(record);
    await deleteCloudflareWorkerByName(scope.accountId, names.workerName, env);
    try {
      await deleteCloudflareBucket(names.objectsBucketName, env);
    } catch (error) {
      if (!isMissingCloudflareBucketError(error)) throw error;
    }
    for (const name of [names.catalogDatabaseName, names.tablesDatabaseName]) {
      await deleteCloudflareD1Database(name, env);
    }
    await runWrangler(remoteR2ObjectDeleteArgs(bucket, cloudflareOwnershipKey(record)), env);
  }
}

function parseD1DatabaseList(raw: string): readonly D1DatabaseInfo[] {
  const payload = JSON.parse(raw) as unknown;
  if (!Array.isArray(payload))
    throw new Error('Cloudflare D1 listing returned an invalid envelope.');
  return payload.map((row) => {
    const database = parseD1DatabaseInfo(row);
    if (database === null) throw new Error('Cloudflare D1 listing returned an invalid database.');
    return database;
  });
}

async function listCloudflareWorkers(
  accountId: string,
  env: Readonly<Record<string, string>>,
): Promise<readonly CloudflareWorkerInfo[]> {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (typeof apiToken !== 'string' || apiToken.trim() === '') {
    throw new Error('CLOUDFLARE_API_TOKEN is required to list Cloudflare Worker scripts.');
  }
  const response = await fetch(cloudflareWorkerListUrl(accountId), {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Cloudflare API Worker list failed with ${response.status}: ${body.trim() === '' ? '(empty response body)' : body}`,
    );
  }
  const payload = (await response.json()) as unknown;
  const rows =
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { success?: unknown }).success === true &&
    Array.isArray((payload as { readonly result?: unknown }).result)
      ? (payload as { readonly result: unknown[] }).result
      : null;
  if (rows === null) throw new Error('Cloudflare Worker listing returned an invalid envelope.');
  return rows.map((row) => {
    const worker = parseNamedResource(row);
    if (worker === null) throw new Error('Cloudflare Worker listing returned an invalid script.');
    return worker;
  });
}

function parseNamedResource(value: unknown): { readonly name: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const name = [row.name, row.id].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '',
  );
  return name === undefined ? null : { name };
}

async function runWrangler(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd = REPO_ROOT,
): Promise<CommandOutput> {
  const artifactsRoot = cloudflareArtifactDirectory(process.env);
  const captureDebugLog = args[0] === 'deploy' && artifactsRoot !== null;
  const debugDirectory = captureDebugLog ? join(artifactsRoot, 'wrangler-debug') : null;
  const debugLogPath =
    debugDirectory === null
      ? null
      : join(debugDirectory, `deploy-${Date.now()}-${randomBytes(8).toString('hex')}.log`);
  if (debugDirectory !== null) mkdirSync(debugDirectory, { recursive: true });

  const result = await execCommand([WRANGLER_BIN, ...args], {
    cwd,
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
    env:
      debugLogPath === null
        ? env
        : {
            ...env,
            WRANGLER_LOG: 'debug',
            WRANGLER_LOG_PATH: debugLogPath,
            WRANGLER_LOG_SANITIZE: 'true',
          },
  });
  let debugLog: string | undefined;
  if (debugLogPath !== null && existsSync(debugLogPath)) {
    if (result.code !== 0) {
      debugLog = redactCloudflareSecrets(readFileSync(debugLogPath, 'utf8'), env);
    }
    unlinkSync(debugLogPath);
  }
  if (artifactsRoot !== null) {
    writeCommandArtifact(artifactsRoot, Date.now(), 'wrangler', args, result, env, debugLog);
  }
  if (result.code !== 0) {
    throw new Error(
      [`wrangler ${args.join(' ')} exited ${result.code}`, result.stderr, result.stdout]
        .filter((line) => line.trim() !== '')
        .join('\n'),
    );
  }
  return result;
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

export function smokeProjectName(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const base = sanitizeName(name);
  if (missingCloudflareTestingEnv(env).length > 0) {
    return base;
  }
  readCloudflareTestingEnv(env);
  return `lpci-${randomBytes(16).toString('hex')}`;
}

export function parseCloudflareTargetReceipt(raw: string): CloudflareTargetReceiptJson {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const accountId = typeof payload.accountId === 'string' ? payload.accountId : null;
  const workerName = typeof payload.workerName === 'string' ? payload.workerName : null;
  const catalogDatabaseName =
    typeof payload.catalogDatabaseName === 'string' ? payload.catalogDatabaseName : null;
  const tablesDatabaseName =
    typeof payload.tablesDatabaseName === 'string' ? payload.tablesDatabaseName : null;
  const objectsBucketName =
    typeof payload.objectsBucketName === 'string' ? payload.objectsBucketName : null;
  if (
    accountId === null ||
    workerName === null ||
    catalogDatabaseName === null ||
    tablesDatabaseName === null ||
    objectsBucketName === null
  ) {
    throw new Error(`lorepack target add cloudflare returned an unreadable receipt:\n${raw}`);
  }
  return {
    accountId,
    workerName,
    catalogDatabaseName,
    tablesDatabaseName,
    objectsBucketName,
  };
}

export function parseWranglerDeploymentInfo(
  stdout: string,
  workerName: string,
): WranglerDeploymentInfo {
  const explicit = stdout.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi)?.[0] ?? null;
  if (explicit !== null) {
    return { endpointBase: explicit };
  }
  return { endpointBase: `https://${workerName}.workers.dev` };
}

export function cloudflareWorkerDeleteUrl(accountId: string, workerName: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`;
}

export function cloudflareWorkerListUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`;
}

export function cloudflareR2BucketListUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`;
}

export function remoteR2ObjectDeleteArgs(
  bucketName: string,
  key: string,
): readonly [string, string, string, string, string] {
  return ['r2', 'object', 'delete', `${bucketName}/${key}`, '--remote'];
}

export function isMissingCloudflareBucketError(error: unknown): boolean {
  const message = messageOf(error);
  return (
    message.includes('The specified bucket does not exist.') && message.includes('[code: 10006]')
  );
}

export function isNonEmptyCloudflareBucketError(error: unknown): boolean {
  const message = messageOf(error);
  return message.includes('is not empty') && message.includes('[code: 10008]');
}

export function isMissingCloudflareD1Error(error: unknown): boolean {
  return messageOf(error).includes("Couldn't find a D1 DB with name or binding");
}

async function deleteCloudflareD1Database(
  name: string,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runWrangler(['d1', 'delete', name, '--skip-confirmation'], env);
      return;
    } catch (error) {
      if (isMissingCloudflareD1Error(error)) return;
      if (!isTransientCloudflareD1DeleteError(error) || attempt >= D1_DELETE_ATTEMPTS) {
        throw error;
      }
      await sleep(D1_DELETE_RETRY_DELAY_MS * attempt);
    }
  }
}

function isTransientCloudflareD1DeleteError(error: unknown): boolean {
  const message = messageOf(error).toLowerCase();
  return message.includes('internal error; reference') && message.includes('[code: 7500]');
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

async function execCommand(
  command: readonly string[],
  options: Parameters<typeof execute>[2],
): Promise<CommandOutput> {
  try {
    const { stdout, stderr } = await execute(process.execPath, command, options);
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout === undefined ? '' : String(failure.stdout),
      stderr: failure.stderr === undefined ? '' : String(failure.stderr),
    };
  }
}

export function writeCommandArtifact(
  root: string,
  sequence: number,
  tool: 'lorepack' | 'wrangler',
  args: readonly string[],
  result: CommandOutput,
  env: Readonly<Record<string, string | undefined>> = process.env,
  debugLog?: string,
): void {
  mkdirSync(root, { recursive: true });
  artifactSequence += 1;
  const digest = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);
  const safeArgs = args.map((arg) => redactCloudflareSecrets(arg, env));
  const command = sanitizeName(safeArgs.join('-') || tool).slice(0, 72);
  const label = `${String(sequence).padStart(4, '0')}-${tool}-${command}-${digest}-${artifactSequence}`;
  const artifactResult = sanitizeCloudflareCommandResult(tool, args, result, env);
  writeFileSync(
    join(root, `${label}.json`),
    `${JSON.stringify(
      {
        tool,
        args: safeArgs,
        ...artifactResult,
        ...(debugLog === undefined ? {} : { debugLog }),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

export function sanitizeCloudflareCommandResult(
  tool: 'lorepack' | 'wrangler',
  args: readonly string[],
  result: CommandOutput,
  env: Readonly<Record<string, string | undefined>>,
): Pick<CommandOutput, 'code' | 'stdout' | 'stderr'> {
  const isAccountWideD1List = tool === 'wrangler' && args[0] === 'd1' && args[1] === 'list';
  return {
    code: result.code,
    stdout: isAccountWideD1List
      ? '[account-wide D1 listing omitted from CI artifact]'
      : redactCloudflareSecrets(result.stdout, env),
    stderr: redactCloudflareSecrets(result.stderr, env),
  };
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

export async function deleteCloudflareBucket(
  bucketName: string,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  const attempts = 5;
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await emptyCloudflareBucket(bucketName, env);
      await runWrangler(['r2', 'bucket', 'delete', bucketName], env);
      return;
    } catch (error) {
      lastFailure = error;
      if (!isNonEmptyCloudflareBucketError(error) || attempt >= attempts) {
        throw error;
      }
      await sleep(1_000 * attempt);
    }
  }
  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure));
}

async function listCloudflareBucketObjectKeys(
  bucketName: string,
  env: Readonly<Record<string, string>>,
  prefix?: string,
): Promise<readonly string[]> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new Error('CLOUDFLARE_ACCOUNT_ID is required to empty an acceptance bucket.');
  }
  const base = `${cloudflareR2BucketListUrl(encodeURIComponent(accountId))}/${encodeURIComponent(bucketName)}/objects`;
  const keys = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const url = new URL(base);
    url.searchParams.set('per_page', '1000');
    if (prefix !== undefined) url.searchParams.set('prefix', prefix);
    if (cursor !== null) url.searchParams.set('cursor', cursor);
    const payload = await cloudflareR2Json(url, 'GET', env);
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('Cloudflare R2 object listing returned no object envelope.');
    }
    const result = payload as { result?: unknown; result_info?: unknown };
    if (!Array.isArray(result.result) || result.result.length > 1000) {
      throw new Error('Cloudflare R2 object listing returned an invalid page.');
    }
    for (const row of result.result) {
      if (
        typeof row !== 'object' ||
        row === null ||
        typeof row.key !== 'string' ||
        row.key === ''
      ) {
        throw new Error('Cloudflare R2 object listing returned an invalid object key.');
      }
      keys.add(row.key);
    }
    const info = result.result_info;
    if (info !== undefined && (typeof info !== 'object' || info === null || Array.isArray(info))) {
      throw new Error('Cloudflare R2 object listing returned invalid pagination metadata.');
    }
    const page = info as { is_truncated?: unknown; cursor?: unknown } | undefined;
    if (page?.is_truncated !== undefined && typeof page.is_truncated !== 'boolean') {
      throw new Error('Cloudflare R2 object listing returned invalid truncation metadata.');
    }
    cursor = null;
    if (page?.is_truncated === true) {
      if (typeof page.cursor !== 'string' || page.cursor === '' || cursors.has(page.cursor)) {
        throw new Error('Cloudflare R2 object listing returned a missing or repeated cursor.');
      }
      cursor = page.cursor;
      cursors.add(cursor);
    }
  } while (cursor !== null);

  return [...keys];
}

async function emptyCloudflareBucket(
  bucketName: string,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  const keys = await listCloudflareBucketObjectKeys(bucketName, env);
  for (const key of keys) await runWrangler(remoteR2ObjectDeleteArgs(bucketName, key), env);
}

export async function cloudflareR2Json(
  url: URL,
  method: 'GET',
  env: Readonly<Record<string, string>>,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<unknown> {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('CLOUDFLARE_API_TOKEN is required for acceptance bucket cleanup.');
  }
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429 && attempt < R2_GET_ATTEMPTS) {
      await wait(r2RetryDelay(response.headers.get('retry-after'), attempt));
      continue;
    }
    const body = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(
        `Cloudflare R2 ${method} returned an invalid JSON response (${response.status}).`,
      );
    }
    if (
      response.ok &&
      typeof payload === 'object' &&
      payload !== null &&
      (payload as { success?: unknown }).success === true
    ) {
      return payload;
    }
    const errors =
      typeof payload === 'object' && payload !== null
        ? (payload as { errors?: unknown }).errors
        : undefined;
    const details = Array.isArray(errors)
      ? errors
          .map((error: { message?: unknown; code?: unknown }) =>
            error !== null && typeof error.message === 'string'
              ? `${error.message} [code: ${String(error.code)}]`
              : 'Unspecified API error',
          )
          .join('; ')
      : 'Missing API error details';
    throw new Error(`Cloudflare R2 ${method} failed (${response.status}): ${details}`);
  }
}

function r2RetryDelay(retryAfter: string | null, attempt: number): number {
  const fallback = R2_GET_RETRY_DELAY_MS * 2 ** (attempt - 1);
  if (retryAfter === null) return fallback;
  const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : Number.NaN;
  const retryAt = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(retryAt)
    ? Math.min(R2_GET_MAX_RETRY_AFTER_MS, Math.max(0, retryAt))
    : fallback;
}

async function deleteCloudflareWorker(target: CloudflareSmokeTarget): Promise<void> {
  await deleteCloudflareWorkerByName(target.accountId, target.workerName, target.wranglerEnv);
}

async function deleteCloudflareWorkerByName(
  accountId: string,
  workerName: string,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (typeof apiToken !== 'string' || apiToken.trim() === '') {
    throw new Error('CLOUDFLARE_API_TOKEN is required to delete the Cloudflare Worker script.');
  }

  const url = new URL(cloudflareWorkerDeleteUrl(accountId, workerName));
  url.searchParams.set('force', 'true');
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok || response.status === 404) {
    return;
  }

  const body = await response.text();
  throw new Error(
    `Cloudflare API delete failed with ${response.status}: ${body.trim() === '' ? '(empty response body)' : body}`,
  );
}
