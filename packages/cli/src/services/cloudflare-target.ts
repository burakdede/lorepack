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
  readCloudflareTargetReceipt,
} from '../commands/target.js';

const execFileAsync = promisify(execFile);
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

export async function resolveCloudflareTarget(projectRoot: string): Promise<DeploymentTarget> {
  return await resolveCloudflareTargetWithAdapter(projectRoot, createWranglerDeployAdapter());
}

export async function resolveCloudflareTargetWithAdapter(
  projectRoot: string,
  adapter: CloudflareResolverAdapter,
): Promise<DeploymentTarget> {
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

  return createCloudflareDeploymentTarget({
    projectId: receipt.project,
    endpoint: `https://${receipt.workerName}.workers.dev/mcp`,
    workerName: receipt.workerName,
    catalogDatabaseName: receipt.catalogDatabaseName,
    objectsBucketName: receipt.objectsBucketName,
    catalogDb: adapter.openCatalogDatabase(receipt.catalogDatabaseName),
    objects: adapter.openObjectsBucket(receipt.objectsBucketName),
    publicBuildId: async () => await readPublicBuildId(receipt.workerName),
  });
}

export function createWranglerDeployAdapter(): CloudflareResolverAdapter {
  return {
    ...createWranglerAdapter(),
    async listDatabases(): Promise<readonly CloudflareDatabaseInfo[]> {
      const { stdout } = await execWrangler(['d1', 'list', '--json']);
      const parsed = JSON.parse(stdout) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(isDatabaseInfo)) {
        throw new Error('Unexpected Wrangler D1 list JSON shape.');
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

  constructor(name: string) {
    this.#name = name;
  }

  prepare(query: string): WranglerStatement {
    return new WranglerStatement(this.#name, query);
  }
}

class WranglerStatement implements ProjectionMigrationStatementLike {
  readonly #databaseName: string;
  readonly #query: string;
  #bindings: readonly unknown[] = [];

  constructor(databaseName: string, query: string) {
    this.#databaseName = databaseName;
    this.#query = query;
  }

  bind(...values: unknown[]): WranglerStatement {
    this.#bindings = values;
    return this;
  }

  async run<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }> {
    const rendered = renderSql(this.#query, this.#bindings);
    const { stdout } = await execWrangler([
      'd1',
      'execute',
      this.#databaseName,
      '--remote',
      '--json',
      '--command',
      rendered,
    ]);
    return { results: readD1Results<T>(JSON.parse(stdout) as unknown) };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const results = await this.run<T>();
    return (results.results?.[0] as T | undefined) ?? null;
  }
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
      await execWrangler(
        ['r2', 'object', 'get', `${this.#name}/${key}`, '--remote', '--file', temp],
        true,
      );
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

async function execWrangler(
  args: readonly string[],
  allowMissingObject = false,
): Promise<{ readonly stdout: string }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [WRANGLER_BIN, ...args], {
      cwd: WRANGLER_CWD,
      env: { ...process.env, NO_D1_WARNING: 'true' },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout };
  } catch (cause) {
    const message = String(
      (cause as { stderr?: string; message?: string }).stderr ??
        (cause as { message?: string }).message ??
        '',
    );
    if (
      allowMissingObject &&
      (message.includes('No such object') ||
        message.includes('The specified key does not exist') ||
        message.includes('Not Found'))
    ) {
      return { stdout: '' };
    }
    throw cause;
  }
}

function tempPath(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return join(directory, 'object.bin');
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
