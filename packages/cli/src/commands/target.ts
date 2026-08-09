import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LoreError, loadConfig, writeFileAtomic } from '@lorepack/core';
import {
  hashRuntimeToken,
  hasRuntimeToken,
  listRuntimeTokens,
  type ProjectionMigrationDatabaseLike,
  type ProjectionMigrationStatementLike,
  RUNTIME_TOKEN_OVERLAP_MS,
  RUNTIME_TOKEN_PREFIX,
  type RuntimeAuthDatabaseLike,
  revokeRuntimeTokens,
  rotateRuntimeTokenHash,
  runProjectionMigrations,
  storeRuntimeTokenHash,
} from '@lorepack/deploy-cloudflare';
import type { CommandContext } from '../framework/context.js';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { targetsDirectory } from '../services/config-resolve.js';

const execFileAsync = promisify(execFile);
const CLOUDFLARE_CAPABILITIES = ['lexical-search', 'structured-context', 'table-query'] as const;
const CLOUDFLARE_SETUP_DOC = 'docs/integrations/cloudflare-target-setup.md' as const;
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

export interface CloudflareTargetReceipt {
  readonly formatVersion: 1;
  readonly target: 'cloudflare';
  readonly project: string;
  readonly configuredAt: string;
  readonly wranglerVersion: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly catalogDatabaseName: string;
  readonly objectsBucketName: string;
  readonly capabilities: readonly string[];
}

export interface WranglerDetection {
  readonly installed: boolean;
  readonly version?: string;
  readonly path?: string;
}

export interface WranglerIdentity {
  readonly authenticated: boolean;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly email?: string;
}

export interface CloudflareTargetAdapter {
  detect(): Promise<WranglerDetection>;
  whoami(): Promise<WranglerIdentity>;
}

export interface CloudflareTargetTokenAdapter extends CloudflareTargetAdapter {
  openCatalogDatabase(name: string): ProjectionMigrationDatabaseLike & RuntimeAuthDatabaseLike;
}

export interface TargetCommandOptions {
  readonly adapter?: CloudflareTargetAdapter | CloudflareTargetTokenAdapter;
  readonly confirm?: (plan: string, context: CommandContext) => Promise<boolean>;
  readonly now?: () => Date;
}

export function targetCommand(options: TargetCommandOptions = {}): CommandDefinition {
  return {
    name: 'target',
    description: 'Prepare and inspect deployment targets.',
    arguments: [
      { name: 'subject', description: 'add or token', required: true },
      { name: 'target', description: 'cloudflare', required: true },
    ],
    flags: [
      { flags: '--dry-run', description: 'show the setup plan and change nothing' },
      { flags: '--yes', description: 'apply without asking' },
      { flags: '--rotate', description: 'replace the current runtime bearer token' },
      { flags: '--revoke', description: 'remove every runtime bearer token' },
      { flags: '--account-id <id>', description: 'connect to an existing Cloudflare account id' },
      { flags: '--worker <name>', description: 'connect to an existing Worker name' },
      { flags: '--catalog-db <name>', description: 'connect to an existing D1 database name' },
      {
        flags: '--objects-bucket <name>',
        description: 'connect to an existing R2 bucket name',
      },
    ],
    handler: async (args, flags, context): Promise<CommandResult> => {
      const subject = args[0];
      const target = args[1];
      if (target !== 'cloudflare' || (subject !== 'add' && subject !== 'token')) {
        throw new LoreError(
          'LORE_E_INVALID_ARGUMENT',
          `Unknown target command: ${[subject, target].filter(Boolean).join(' ')}.`,
          {
            remediation: 'Use `lore target add cloudflare` or `lore target token cloudflare`.',
            subject: [subject, target].filter(Boolean).join(' '),
          },
        );
      }

      if (subject === 'token') return await handleTokenCommand(flags, context, options);

      const config = loadConfig({ cwd: context.options.cwd });
      const adapter = options.adapter ?? createWranglerAdapter();
      const detection = await adapter.detect();
      if (!detection.installed) {
        throw new LoreError(
          'LORE_E_TARGET_NOT_CONFIGURED',
          'The pinned Cloudflare Wrangler dependency is not available.',
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

      const defaults = defaultNames(config.config.name);
      const existing = readCloudflareTargetReceiptIfPresent(config.projectRoot);
      const planned = {
        accountId:
          typeof flags.accountId === 'string'
            ? flags.accountId
            : (existing?.accountId ??
              identity.accountId ??
              '(required to connect existing resources)'),
        workerName:
          typeof flags.worker === 'string'
            ? flags.worker
            : (existing?.workerName ?? defaults.workerName),
        catalogDatabaseName:
          typeof flags.catalogDb === 'string'
            ? flags.catalogDb
            : (existing?.catalogDatabaseName ?? defaults.catalogDatabaseName),
        objectsBucketName:
          typeof flags.objectsBucket === 'string'
            ? flags.objectsBucket
            : (existing?.objectsBucketName ?? defaults.objectsBucketName),
      };

      const plan = renderCloudflarePlan({
        project: config.config.name,
        wranglerVersion: detection.version ?? 'unknown',
        identity,
        planned,
        existing,
      });

      if (flags.dryRun === true) {
        return {
          human: `${plan}\n\n(dry run, nothing was changed)`,
          json: {
            target: 'cloudflare',
            project: config.config.name,
            wranglerVersion: detection.version ?? null,
            identity,
            planned,
            capabilities: CLOUDFLARE_CAPABILITIES,
          },
        };
      }

      if (flags.yes !== true) {
        const confirmed = await (options.confirm ?? confirmTargetSetup)(plan, context);
        if (!confirmed) return { human: `${plan}\n\nCancelled. Nothing was changed.` };
      }

      const drift = existing === null ? [] : compareReceipt(existing, planned);
      if (drift.length > 0) {
        throw new LoreError(
          'LORE_E_TARGET_NOT_CONFIGURED',
          `The cloudflare target receipt does not match the requested resources: ${drift
            .map((entry) => entry.field)
            .join(', ')}.`,
          {
            remediation: `Fix the drift or remove ${cloudflareTargetPath(config.projectRoot)} and set the target up again.\n${drift
              .map(
                (entry) =>
                  `  ${entry.field}: receipt=${entry.current} requested=${entry.requested}`,
              )
              .join('\n')}`,
            subject: 'cloudflare',
          },
        );
      }

      if (
        existing !== null &&
        typeof flags.accountId !== 'string' &&
        typeof flags.worker !== 'string' &&
        typeof flags.catalogDb !== 'string' &&
        typeof flags.objectsBucket !== 'string'
      ) {
        return {
          human: `${plan}\n\ncloudflare already matches ${cloudflareTargetPath(config.projectRoot)}.`,
          json: existing,
        };
      }

      if (
        typeof flags.accountId !== 'string' ||
        typeof flags.worker !== 'string' ||
        typeof flags.catalogDb !== 'string' ||
        typeof flags.objectsBucket !== 'string'
      ) {
        throw new LoreError(
          'LORE_E_TARGET_NOT_CONFIGURED',
          'Connecting existing Cloudflare resources requires explicit identifiers in this slice.',
          {
            remediation:
              'Pass --account-id, --worker, --catalog-db, and --objects-bucket to connect existing resources, or use --dry-run to inspect the deterministic names first.',
            subject: 'cloudflare',
          },
        );
      }

      const receipt: CloudflareTargetReceipt = {
        formatVersion: 1,
        target: 'cloudflare',
        project: config.config.name,
        configuredAt: (options.now ?? (() => new Date()))().toISOString(),
        wranglerVersion: detection.version ?? 'unknown',
        accountId: flags.accountId,
        workerName: flags.worker,
        catalogDatabaseName: flags.catalogDb,
        objectsBucketName: flags.objectsBucket,
        capabilities: [...CLOUDFLARE_CAPABILITIES],
      };
      const path = cloudflareTargetPath(config.projectRoot);
      writeFileAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`);

      return {
        human: `${plan}\n\nConfigured cloudflare for ${config.config.name}.\nReceipt: ${path}`,
        json: receipt,
      };
    },
  };
}

async function handleTokenCommand(
  flags: Record<string, unknown>,
  context: CommandContext,
  options: TargetCommandOptions,
): Promise<CommandResult> {
  if (flags.rotate === true && flags.revoke === true) {
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      'Choose either --rotate or --revoke, not both.',
      {
        remediation: 'Use `lore target token cloudflare --rotate` or `--revoke`.',
      },
    );
  }

  const config = loadConfig({ cwd: context.options.cwd });
  const adapter = options.adapter ?? createWranglerAdapter();
  if (!isCloudflareTargetTokenAdapter(adapter)) {
    throw new LoreError(
      'LORE_E_INTERNAL',
      'The Cloudflare target adapter cannot open the catalog database for token management.',
      {
        remediation:
          'Use the default Wrangler-backed adapter, or provide an adapter with openCatalogDatabase().',
      },
    );
  }
  const detection = await adapter.detect();
  if (!detection.installed) {
    throw new LoreError(
      'LORE_E_TARGET_NOT_CONFIGURED',
      'The pinned Cloudflare Wrangler dependency is not available.',
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

  const receipt = readCloudflareTargetReceipt(config.projectRoot);
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

  const db = adapter.openCatalogDatabase(receipt.catalogDatabaseName);
  await runProjectionMigrations(db);

  if (flags.revoke === true) {
    const revoked = await revokeRuntimeTokens(db);
    return {
      human:
        revoked === 0
          ? `No runtime token was configured for ${receipt.workerName}.`
          : `Revoked ${revoked} runtime token${revoked === 1 ? '' : 's'} for ${receipt.workerName}.`,
      json: { target: 'cloudflare', worker: receipt.workerName, revoked },
    };
  }

  const alreadyConfigured = await hasRuntimeToken(db);
  if (alreadyConfigured && flags.rotate !== true) {
    throw new LoreError(
      'LORE_E_TARGET_NOT_CONFIGURED',
      `A runtime token already exists for ${receipt.workerName}.`,
      {
        remediation:
          'Use `lore target token cloudflare --rotate` to replace it, or `--revoke` to remove it first.',
        subject: receipt.workerName,
      },
    );
  }

  const token = issueRuntimeToken();
  const issuedAt = (options.now ?? (() => new Date()))();
  const issuedAtIso = issuedAt.toISOString();
  const overlapEndsAt =
    alreadyConfigured === true
      ? new Date(issuedAt.getTime() + RUNTIME_TOKEN_OVERLAP_MS).toISOString()
      : null;
  if (overlapEndsAt === null) {
    await storeRuntimeTokenHash(db, await hashRuntimeToken(token), issuedAtIso);
  } else {
    await rotateRuntimeTokenHash(db, await hashRuntimeToken(token), issuedAtIso, overlapEndsAt);
  }

  const action = alreadyConfigured ? 'Rotated' : 'Generated';
  const activeTokens = await listRuntimeTokens(db);
  return {
    human: [
      `${action} the runtime bearer token for ${receipt.workerName}.`,
      ...(overlapEndsAt === null
        ? []
        : [`The previous token remains valid until ${overlapEndsAt}.`]),
      'Token (shown once):',
      token,
      '',
      'Set it in your shell before running remote verification or client requests:',
      `  export LORE_REMOTE_BEARER_TOKEN=${token}`,
    ].join('\n'),
    json: {
      target: 'cloudflare',
      worker: receipt.workerName,
      rotated: alreadyConfigured,
      activeTokens,
      ...(overlapEndsAt === null ? {} : { overlapEndsAt }),
      token,
    },
  };
}

export function cloudflareTargetPath(projectRoot: string): string {
  return join(targetsDirectory(projectRoot), 'cloudflare.json');
}

function renderCloudflarePlan(input: {
  readonly project: string;
  readonly wranglerVersion: string;
  readonly identity: WranglerIdentity;
  readonly existing: CloudflareTargetReceipt | null;
  readonly planned: {
    readonly accountId: string;
    readonly workerName: string;
    readonly catalogDatabaseName: string;
    readonly objectsBucketName: string;
  };
}): string {
  const lines = [`Cloudflare target plan for ${input.project}`, ''];
  lines.push('Authentication');
  lines.push(`  Wrangler ${input.wranglerVersion}`);
  lines.push(
    `  ${input.identity.email ?? 'Cloudflare user'}${input.identity.accountName === undefined ? '' : ` on ${input.identity.accountName}`}`,
  );
  lines.push('');
  lines.push('Resources');
  lines.push(`  Worker: ${input.planned.workerName}`);
  lines.push(`  D1 catalog: ${input.planned.catalogDatabaseName}`);
  lines.push(`  R2 objects: ${input.planned.objectsBucketName}`);
  lines.push(`  Account: ${input.planned.accountId}`);
  lines.push('');
  lines.push('Capabilities');
  lines.push(`  ${CLOUDFLARE_CAPABILITIES.join(', ')}`);
  lines.push('');
  lines.push('Receipt');
  lines.push('  Write non-secret Cloudflare identifiers under .lore/targets/cloudflare.json');
  if (input.existing !== null) {
    lines.push('  Existing receipt found and will be checked for drift before any rewrite');
  }
  lines.push('');
  lines.push('Permissions');
  lines.push(`  ${CLOUDFLARE_SETUP_DOC}`);
  return lines.join('\n');
}

function compareReceipt(
  existing: CloudflareTargetReceipt,
  requested: {
    readonly accountId: string;
    readonly workerName: string;
    readonly catalogDatabaseName: string;
    readonly objectsBucketName: string;
  },
): Array<{ readonly field: string; readonly current: string; readonly requested: string }> {
  const drift: Array<{
    readonly field: string;
    readonly current: string;
    readonly requested: string;
  }> = [];
  if (existing.accountId !== requested.accountId) {
    drift.push({ field: 'accountId', current: existing.accountId, requested: requested.accountId });
  }
  if (existing.workerName !== requested.workerName) {
    drift.push({
      field: 'workerName',
      current: existing.workerName,
      requested: requested.workerName,
    });
  }
  if (existing.catalogDatabaseName !== requested.catalogDatabaseName) {
    drift.push({
      field: 'catalogDatabaseName',
      current: existing.catalogDatabaseName,
      requested: requested.catalogDatabaseName,
    });
  }
  if (existing.objectsBucketName !== requested.objectsBucketName) {
    drift.push({
      field: 'objectsBucketName',
      current: existing.objectsBucketName,
      requested: requested.objectsBucketName,
    });
  }
  return drift;
}

function defaultNames(project: string): {
  readonly workerName: string;
  readonly catalogDatabaseName: string;
  readonly objectsBucketName: string;
} {
  const slug = project
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return {
    workerName: `${slug}-runtime`,
    catalogDatabaseName: `${slug}-catalog`,
    objectsBucketName: `${slug}-objects`,
  };
}

export function createWranglerAdapter(): CloudflareTargetTokenAdapter {
  return {
    async detect(): Promise<WranglerDetection> {
      if (!existsSync(WRANGLER_BIN)) return { installed: false };
      const { stdout } = await execFileAsync(process.execPath, [WRANGLER_BIN, '--version'], {
        cwd: join(import.meta.dirname, '..', '..', '..', 'deploy-cloudflare'),
      });
      return { installed: true, version: stdout.trim(), path: WRANGLER_BIN };
    },
    async whoami(): Promise<WranglerIdentity> {
      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          [WRANGLER_BIN, 'whoami', '--json'],
          {
            cwd: join(import.meta.dirname, '..', '..', '..', 'deploy-cloudflare'),
            env: { ...process.env, NO_D1_WARNING: 'true' },
          },
        );
        const parsed = JSON.parse(stdout) as {
          email?: string;
          accounts?: Array<{ id?: string; name?: string }>;
        };
        return {
          authenticated: true,
          ...(parsed.email === undefined ? {} : { email: parsed.email }),
          ...(parsed.accounts?.[0]?.id === undefined ? {} : { accountId: parsed.accounts[0].id }),
          ...(parsed.accounts?.[0]?.name === undefined
            ? {}
            : { accountName: parsed.accounts[0].name }),
        };
      } catch {
        return { authenticated: false };
      }
    },
    openCatalogDatabase(name) {
      return new WranglerCatalogDatabase(name);
    },
  };
}

function isCloudflareTargetTokenAdapter(
  adapter: CloudflareTargetAdapter | CloudflareTargetTokenAdapter,
): adapter is CloudflareTargetTokenAdapter {
  return (
    typeof (adapter as Partial<CloudflareTargetTokenAdapter>).openCatalogDatabase === 'function'
  );
}

async function confirmTargetSetup(plan: string, context: CommandContext): Promise<boolean> {
  if (!context.streams.isTty) {
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      'Target setup confirmation requires a terminal when --yes is not given.',
      {
        remediation: 'Re-run with `--yes` in CI or another non-interactive environment.',
      },
    );
  }

  context.write(`${plan}\n\nWrite this target receipt? [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => resolve(String(chunk)));
  });
  return /^y(es)?\s*$/i.test(answer.trim());
}

export function readCloudflareTargetReceipt(projectRoot: string): CloudflareTargetReceipt {
  const path = cloudflareTargetPath(projectRoot);
  if (!existsSync(path)) {
    throw new LoreError(
      'LORE_E_TARGET_NOT_CONFIGURED',
      'This project has no cloudflare target receipt.',
      {
        remediation: 'Run `lore target add cloudflare` first.',
        subject: 'cloudflare',
      },
    );
  }
  return readCloudflareTargetReceiptFile(path);
}

function readCloudflareTargetReceiptIfPresent(projectRoot: string): CloudflareTargetReceipt | null {
  const path = cloudflareTargetPath(projectRoot);
  if (!existsSync(path)) return null;
  return readCloudflareTargetReceiptFile(path);
}

function readCloudflareTargetReceiptFile(path: string): CloudflareTargetReceipt {
  try {
    return parseCloudflareTargetReceipt(JSON.parse(readFileSync(path, 'utf8')), path);
  } catch (cause) {
    if (cause instanceof LoreError) throw cause;
    throw new LoreError(
      'LORE_E_TARGET_NOT_CONFIGURED',
      `The cloudflare target receipt at ${path} could not be read.`,
      {
        remediation:
          'Fix or remove the unreadable receipt, then run `lore target add cloudflare` again.',
        subject: path,
        cause,
      },
    );
  }
}

function parseCloudflareTargetReceipt(raw: unknown, path: string): CloudflareTargetReceipt {
  if (!isCloudflareTargetReceipt(raw)) {
    throw new LoreError(
      'LORE_E_TARGET_NOT_CONFIGURED',
      `The cloudflare target receipt at ${path} is invalid.`,
      {
        remediation:
          'Remove the invalid receipt and run `lore target add cloudflare` again so it is rewritten.',
        subject: path,
      },
    );
  }
  return raw;
}

function isCloudflareTargetReceipt(raw: unknown): raw is CloudflareTargetReceipt {
  if (typeof raw !== 'object' || raw === null) return false;
  const receipt = raw as Record<string, unknown>;
  return (
    receipt.formatVersion === 1 &&
    receipt.target === 'cloudflare' &&
    typeof receipt.project === 'string' &&
    typeof receipt.configuredAt === 'string' &&
    typeof receipt.wranglerVersion === 'string' &&
    typeof receipt.accountId === 'string' &&
    typeof receipt.workerName === 'string' &&
    typeof receipt.catalogDatabaseName === 'string' &&
    typeof receipt.objectsBucketName === 'string' &&
    Array.isArray(receipt.capabilities) &&
    receipt.capabilities.every((value) => typeof value === 'string')
  );
}

class WranglerCatalogDatabase implements ProjectionMigrationDatabaseLike, RuntimeAuthDatabaseLike {
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
}

function issueRuntimeToken(): string {
  return `${RUNTIME_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
}

async function execWrangler(args: readonly string[]): Promise<{ readonly stdout: string }> {
  const { stdout } = await execFileAsync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: join(import.meta.dirname, '..', '..', '..', 'deploy-cloudflare'),
    env: { ...process.env, NO_D1_WARNING: 'true' },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout };
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
  const value = raw as { readonly results?: readonly T[]; readonly result?: readonly T[] };
  if (Array.isArray(value.results)) return value.results;
  if (Array.isArray(value.result)) return value.result;
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
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  throw new LoreError(
    'LORE_E_INTERNAL',
    `Unsupported Cloudflare D1 binding type ${typeof value}.`,
    {
      remediation: 'Fix the Cloudflare CLI adapter so it writes only scalar SQLite values.',
    },
  );
}
