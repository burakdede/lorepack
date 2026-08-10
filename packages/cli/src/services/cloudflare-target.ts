import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type BuildId, type DeploymentTarget, LoreError } from '@lorepack/core';
import {
  createCloudflareDeploymentTarget,
  type D1CatalogDatabaseLike,
  type D1DatabaseLike,
  type D1QueryDatabaseLike,
  type ProjectionMigrationDatabaseLike,
  type ProjectionMigrationStatementLike,
  type R2BucketLike,
} from '@lorepack/deploy-cloudflare';
import {
  type CloudflareTargetAdapter,
  createWranglerAdapter,
  isRetryableWranglerRemoteD1Failure,
  readCloudflareTargetReceipt,
} from '../commands/target.js';

const execFileAsync = promisify(execFile);
const WRANGLER_REMOTE_D1_RETRY_LIMIT = 3;
const WRANGLER_BIN = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'deploy-cloudflare',
  'node_modules',
  'wrangler',
  'bin',
  'wrangler.js',
);
const WRANGLER_CWD = join(import.meta.dirname, '..', '..', '..', 'deploy-cloudflare');

interface CloudflareDatabaseInfo {
  readonly name: string;
}

export interface ResolvedCloudflareTargetResources {
  readonly receipt: ReturnType<typeof readCloudflareTargetReceipt>;
  readonly endpoint: string;
  readonly catalogDb: ProjectionMigrationDatabaseLike &
    D1CatalogDatabaseLike &
    D1QueryDatabaseLike &
    D1DatabaseLike;
  readonly objects: R2BucketLike;
}

export interface CloudflareResolverAdapter extends CloudflareTargetAdapter {
  listDatabases(): Promise<readonly CloudflareDatabaseInfo[]>;
  openCatalogDatabase(
    name: string,
  ): ProjectionMigrationDatabaseLike & D1CatalogDatabaseLike & D1QueryDatabaseLike & D1DatabaseLike;
  openObjectsBucket(name: string): R2BucketLike;
}

interface WranglerD1ExecuteResponse {
  readonly results?: readonly Record<string, unknown>[];
  readonly result?: readonly Record<string, unknown>[];
  readonly success?: boolean;
}

interface WranglerExecResult {
  readonly stdout: string;
  readonly missingObject?: boolean;
}

const WRANGLER_D1_TRANSACTION_CONTROL = new Set(['begin immediate', 'commit', 'rollback']);

export async function resolveCloudflareTarget(projectRoot: string): Promise<DeploymentTarget> {
  return await resolveCloudflareTargetWithAdapter(projectRoot, createWranglerDeployAdapter());
}

export async function resolveCloudflareTargetWithAdapter(
  projectRoot: string,
  adapter: CloudflareResolverAdapter,
): Promise<DeploymentTarget> {
  const resolved = await resolveCloudflareResourcesWithAdapter(projectRoot, adapter);
  return createCloudflareDeploymentTarget({
    projectId: resolved.receipt.project,
    endpoint: resolved.endpoint,
    workerName: resolved.receipt.workerName,
    catalogDatabaseName: resolved.receipt.catalogDatabaseName,
    objectsBucketName: resolved.receipt.objectsBucketName,
    catalogDb: resolved.catalogDb,
    objects: resolved.objects,
    publicBuildId: async () => await readPublicBuildId(resolved.receipt.workerName),
  });
}

export async function resolveCloudflareResourcesWithAdapter(
  projectRoot: string,
  adapter: CloudflareResolverAdapter,
): Promise<ResolvedCloudflareTargetResources> {
  const receipt = readCloudflareTargetReceipt(projectRoot);
  const detection = await adapter.detect();
  if (!detection.installed) {
    throw new LoreError(
      'LORE_E_TARGET_NOT_CONFIGURED',
      'The pinned Cloudflare Wrangler dependency is not available for deploy resolution.',
      {
        remediation: 'Run `pnpm install` so the pinned Wrangler dependency is available.',
        subject: 'cloudflare',
      },
    );
  }

  const identity = await adapter.whoami();
  if (!identity.authenticated) {
    throw new LoreError(
      'LORE_E_TARGET_NOT_CONFIGURED',
      'Wrangler is installed, but no Cloudflare login is available for this machine.',
      {
        remediation: `Log in first with \`${process.execPath} ${detection.path ?? WRANGLER_BIN} login --device\`.`,
        subject: 'cloudflare',
      },
    );
  }

  if (identity.accountId !== undefined && identity.accountId !== receipt.accountId) {
    throw new LoreError(
      'LORE_E_TARGET_NOT_CONFIGURED',
      `The cloudflare target receipt belongs to account ${receipt.accountId}, but Wrangler is logged into ${identity.accountId}.`,
      {
        remediation:
          'Log into the matching Cloudflare account or rewrite the receipt with `lore target add cloudflare`.',
        subject: receipt.accountId,
      },
    );
  }

  const databases = await adapter.listDatabases().catch((cause) => {
    throw new LoreError(
      'LORE_E_TARGET_NOT_CONFIGURED',
      'The CLI could not inspect Cloudflare D1 databases through the pinned Wrangler dependency.',
      {
        remediation:
          'Check that Wrangler is installed and authenticated, then retry `lore deploy cloudflare`.',
        subject: receipt.catalogDatabaseName,
        cause,
      },
    );
  });
  if (!databases.some((database) => database.name === receipt.catalogDatabaseName)) {
    throw new LoreError(
      'LORE_E_TARGET_NOT_CONFIGURED',
      `The cloudflare target receipt refers to D1 database ${receipt.catalogDatabaseName}, but it is not visible to the current Cloudflare account.`,
      {
        remediation:
          'Fix the receipt or create the expected D1 database, then run `lore target add cloudflare` again.',
        subject: receipt.catalogDatabaseName,
      },
    );
  }

  return {
    receipt,
    endpoint: `https://${receipt.workerName}.workers.dev/mcp`,
    catalogDb: adapter.openCatalogDatabase(receipt.catalogDatabaseName),
    objects: adapter.openObjectsBucket(receipt.objectsBucketName),
  };
}

export function createWranglerDeployAdapter(): CloudflareResolverAdapter {
  return {
    ...createWranglerAdapter(),
    async listDatabases(): Promise<readonly CloudflareDatabaseInfo[]> {
      const { stdout } = await execWrangler(['d1', 'list', '--json']);
      const parsed = parseWranglerJson(stdout);
      if (!Array.isArray(parsed) || !parsed.every(isDatabaseInfo)) {
        throw new LoreError(
          'LORE_E_TARGET_NOT_CONFIGURED',
          'Wrangler returned an unreadable Cloudflare D1 list response.',
          {
            remediation:
              'Check that Wrangler is current and authenticated, then retry `lore deploy cloudflare`.',
            subject: 'cloudflare',
          },
        );
      }
      return parsed;
    },
    openCatalogDatabase(name) {
      return new WranglerCatalogDatabase(name);
    },
    openObjectsBucket(name) {
      return new WranglerR2Bucket(name);
    },
  };
}

class WranglerCatalogDatabase
  implements
    ProjectionMigrationDatabaseLike,
    D1CatalogDatabaseLike,
    D1QueryDatabaseLike,
    D1DatabaseLike
{
  readonly #name: string;
  readonly #transaction = new WranglerD1TransactionBatch();

  constructor(name: string) {
    this.#name = name;
  }

  prepare(query: string): WranglerStatement {
    return new WranglerStatement(this.#name, this.#transaction, query);
  }
}

class WranglerStatement implements ProjectionMigrationStatementLike {
  readonly #databaseName: string;
  readonly #transaction: WranglerD1TransactionBatch;
  readonly #query: string;
  #bindings: readonly unknown[] = [];

  constructor(databaseName: string, transaction: WranglerD1TransactionBatch, query: string) {
    this.#databaseName = databaseName;
    this.#transaction = transaction;
    this.#query = query;
  }

  bind(...values: unknown[]): WranglerStatement {
    this.#bindings = values;
    return this;
  }

  async run<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }> {
    const control = wranglerD1TransactionControl(this.#query);
    if (control === 'begin') {
      this.#transaction.begin();
      return {};
    }
    if (control === 'rollback') {
      this.#transaction.rollback();
      return {};
    }
    if (control === 'commit') {
      const flushed = this.#transaction.commit();
      if (flushed === null) return {};
      const { stdout } = await execWranglerSqlFile(this.#databaseName, flushed);
      return { results: readD1Results<T>(parseWranglerJson(stdout)) };
    }

    const mode = wranglerD1ExecutionMode(this.#query);
    const rendered = renderSql(this.#query, this.#bindings);
    if (mode === 'file' && this.#transaction.active) {
      this.#transaction.stage(rendered);
      return {};
    }
    if (mode === 'command' && this.#transaction.active) {
      const flushed = this.#transaction.flush();
      if (flushed !== null) {
        await execWranglerSqlFile(this.#databaseName, flushed);
      }
    }
    const { stdout } =
      mode === 'file'
        ? await execWranglerSqlFile(this.#databaseName, rendered)
        : await execWrangler([
            'd1',
            'execute',
            this.#databaseName,
            '--remote',
            '--json',
            '--command',
            rendered,
          ]);
    return { results: readD1Results<T>(parseWranglerJson(stdout)) };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const results = await this.run<T>();
    return (results.results?.[0] as T | undefined) ?? null;
  }
}

export function isWranglerD1TransactionControl(query: string): boolean {
  return wranglerD1TransactionControl(query) !== null;
}

export function wranglerD1ExecutionMode(query: string): 'skip' | 'command' | 'file' {
  if (wranglerD1TransactionControl(query) !== null) return 'skip';
  return isWranglerD1ReadQuery(query) ? 'command' : 'file';
}

export class WranglerD1TransactionBatch {
  #statements: string[] | null = null;

  get active(): boolean {
    return this.#statements !== null;
  }

  begin(): void {
    this.#statements = [];
  }

  stage(sql: string): void {
    if (this.#statements === null) return;
    this.#statements.push(sql);
  }

  flush(): string | null {
    const statements = this.#statements;
    if (statements === null || statements.length === 0) return null;
    this.#statements = [];
    return renderWranglerSqlBatch(statements);
  }

  commit(): string | null {
    const flushed = this.flush();
    this.#statements = null;
    return flushed;
  }

  rollback(): void {
    this.#statements = null;
  }
}

export function renderWranglerSqlBatch(statements: readonly string[]): string {
  return statements.map(terminateSql).join('\n');
}

function wranglerD1TransactionControl(query: string): 'begin' | 'commit' | 'rollback' | null {
  const normalized = query.trim().toLowerCase();
  if (!WRANGLER_D1_TRANSACTION_CONTROL.has(normalized)) return null;
  if (normalized === 'begin immediate') return 'begin';
  if (normalized === 'commit') return 'commit';
  return 'rollback';
}

function isWranglerD1ReadQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return (
    normalized.startsWith('select') ||
    normalized.startsWith('pragma') ||
    normalized.startsWith('with')
  );
}

class WranglerR2Bucket implements R2BucketLike {
  readonly #name: string;

  constructor(name: string) {
    this.#name = name;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const temp = tempPath('lore-r2-put-');
    try {
      writeFileSync(temp, value);
      await execWrangler([
        'r2',
        'object',
        'put',
        `${this.#name}/${key}`,
        '--remote',
        '--file',
        temp,
      ]);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const temp = tempPath('lore-r2-get-');
    try {
      const result = await execWrangler(
        ['r2', 'object', 'get', `${this.#name}/${key}`, '--remote', '--file', temp],
        true,
      );
      if (result.missingObject === true) return null;
      if (!readableFileExists(temp)) return null;
      const body = readFileSync(temp);
      return {
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      };
    } finally {
      rmSync(temp, { force: true });
    }
  }

  async head(key: string): Promise<Record<string, never> | null> {
    return (await this.get(key)) === null ? null : {};
  }

  async delete(key: string): Promise<void> {
    await execWrangler(['r2', 'object', 'delete', `${this.#name}/${key}`, '--remote']);
  }
}

function isDatabaseInfo(value: unknown): value is CloudflareDatabaseInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

function readD1Results<T>(raw: unknown): readonly T[] {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const results = readResultsArray<T>(item);
      if (results !== null) return results;
    }
    return [];
  }
  return readResultsArray<T>(raw) ?? [];
}

function readResultsArray<T>(raw: unknown): readonly T[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as WranglerD1ExecuteResponse;
  if (Array.isArray(value.results)) return value.results as readonly T[];
  if (Array.isArray(value.result)) return value.result as readonly T[];
  return null;
}

export function parseWranglerJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    const start = findWranglerJsonStart(stdout);
    if (start === null) throw error;
    return JSON.parse(stdout.slice(start)) as unknown;
  }
}

function renderSql(query: string, bindings: readonly unknown[]): string {
  let index = 0;
  const rendered = query.replace(/\?/g, () => {
    if (index >= bindings.length) {
      throw new LoreError(
        'LORE_E_INTERNAL',
        'A Cloudflare D1 statement was missing a bound value.',
        {
          remediation: 'Fix the Cloudflare CLI adapter so every placeholder is bound exactly once.',
        },
      );
    }
    return literalFor(bindings[index++]);
  });
  if (index !== bindings.length) {
    throw new LoreError('LORE_E_INTERNAL', 'A Cloudflare D1 statement bound too many values.', {
      remediation: 'Fix the Cloudflare CLI adapter so every placeholder is bound exactly once.',
    });
  }
  return rendered;
}

function findWranglerJsonStart(stdout: string): number | null {
  const objectStart = stdout.indexOf('{');
  const arrayStart = stdout.indexOf('[');
  if (objectStart === -1 && arrayStart === -1) return null;
  if (objectStart === -1) return arrayStart;
  if (arrayStart === -1) return objectStart;
  return Math.min(objectStart, arrayStart);
}

function literalFor(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new LoreError('LORE_E_INTERNAL', 'Refusing to render a non-finite D1 number literal.', {
        remediation: 'Fix the Cloudflare CLI adapter so it writes only finite numeric values.',
      });
    }
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  throw new LoreError(
    'LORE_E_INTERNAL',
    `Unsupported Cloudflare D1 binding type ${typeof value}.`,
    {
      remediation: 'Fix the Cloudflare CLI adapter so it writes only scalar SQLite values.',
    },
  );
}

function terminateSql(sql: string): string {
  return sql.trimEnd().endsWith(';') ? sql : `${sql};`;
}

function isWranglerRemoteD1Execute(args: readonly string[]): boolean {
  return args[0] === 'd1' && args[1] === 'execute' && args.includes('--remote');
}

function wranglerExecFailure(cause: unknown): Error {
  const failure = cause as {
    readonly message?: string;
    readonly stdout?: string | Buffer;
    readonly stderr?: string | Buffer;
  };
  const stdout = failure.stdout === undefined ? '' : String(failure.stdout);
  const stderr = failure.stderr === undefined ? '' : String(failure.stderr);
  const message = [failure.message ?? 'Wrangler execution failed.', stderr, stdout]
    .filter((part) => part.trim() !== '')
    .join('\n');
  return new Error(message);
}

export function isWranglerMissingObjectFailure(text: string): boolean {
  return (
    text.includes('No such object') ||
    text.includes('The specified key does not exist') ||
    text.includes('Not Found')
  );
}

export function isRetryableWranglerRemoteR2Failure(text: string): boolean {
  return (
    text.includes("Unable to resolve Cloudflare's API hostname") || text.includes('fetch failed')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execWrangler(
  args: readonly string[],
  allowMissingObject = false,
): Promise<WranglerExecResult> {
  const attempts =
    isWranglerRemoteD1Execute(args) || isWranglerRemoteR2ObjectCommand(args)
      ? WRANGLER_REMOTE_D1_RETRY_LIMIT
      : 1;
  let lastFailure: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [WRANGLER_BIN, ...args], {
        cwd: WRANGLER_CWD,
        env: { ...process.env, NO_D1_WARNING: 'true' },
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout };
    } catch (cause) {
      const failure = wranglerExecFailure(cause);
      lastFailure = failure;
      if (allowMissingObject && isWranglerMissingObjectFailure(failure.message)) {
        return { stdout: '', missingObject: true };
      }
      if (attempt >= attempts || !isRetryableWranglerRemoteWranglerFailure(args, failure.message)) {
        throw failure;
      }
      await sleep(250 * attempt);
    }
  }
  throw lastFailure ?? new Error('Wrangler execution failed without an error message.');
}

async function execWranglerSqlFile(
  databaseName: string,
  sql: string,
): Promise<{ readonly stdout: string }> {
  const path = tempPath('lore-d1-execute-', 'statement.sql');
  try {
    writeFileSync(path, sql, 'utf8');
    return await execWrangler([
      'd1',
      'execute',
      databaseName,
      '--remote',
      '--json',
      '--file',
      path,
    ]);
  } finally {
    rmSync(path, { force: true });
  }
}

function tempPath(prefix: string, filename = 'object.bin'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return join(directory, filename);
}

function isWranglerRemoteR2ObjectCommand(args: readonly string[]): boolean {
  return args[0] === 'r2' && args[1] === 'object' && args.includes('--remote');
}

function isRetryableWranglerRemoteWranglerFailure(args: readonly string[], text: string): boolean {
  if (isWranglerRemoteD1Execute(args)) {
    return isRetryableWranglerRemoteD1Failure(text);
  }
  if (isWranglerRemoteR2ObjectCommand(args)) {
    return isRetryableWranglerRemoteR2Failure(text);
  }
  return false;
}

function readableFileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

async function readPublicBuildId(workerName: string): Promise<BuildId | null> {
  try {
    const token = process.env.LORE_REMOTE_BEARER_TOKEN;
    const headers =
      token === undefined || token.trim() === ''
        ? null
        : { Authorization: `Bearer ${token.trim()}` };
    const response = await fetch(`https://${workerName}.workers.dev/v1/build`, {
      ...(headers === null ? {} : { headers }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { readonly buildId?: unknown };
    return isBuildId(payload.buildId) ? payload.buildId : null;
  } catch {
    return null;
  }
}

function isBuildId(value: unknown): value is BuildId {
  return typeof value === 'string' && /^lore_[0-9a-f]{64}$/.test(value);
}
