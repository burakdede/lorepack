import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LoreError, loadConfig, writeFileAtomic } from '@lorepack/core';
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

export interface TargetCommandOptions {
  readonly adapter?: CloudflareTargetAdapter;
  readonly confirm?: (plan: string, context: CommandContext) => Promise<boolean>;
  readonly now?: () => Date;
}

export function targetCommand(options: TargetCommandOptions = {}): CommandDefinition {
  return {
    name: 'target',
    description: 'Prepare and inspect deployment targets.',
    arguments: [
      { name: 'subject', description: 'add', required: true },
      { name: 'target', description: 'cloudflare', required: true },
    ],
    flags: [
      { flags: '--dry-run', description: 'show the setup plan and change nothing' },
      { flags: '--yes', description: 'apply without asking' },
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
      if (subject !== 'add' || target !== 'cloudflare') {
        throw new LoreError(
          'LORE_E_INVALID_ARGUMENT',
          `Unknown target command: ${[subject, target].filter(Boolean).join(' ')}.`,
          {
            remediation: 'Use `lore target add cloudflare`.',
            subject: [subject, target].filter(Boolean).join(' '),
          },
        );
      }

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

export function createWranglerAdapter(): CloudflareTargetAdapter {
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
  };
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
