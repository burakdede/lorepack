import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPlan, readLockfile, renderPlan } from '@lorepack/compiler';
import {
  type BuildId,
  buildManifestSchema,
  type Capability,
  type DeploymentReceipt,
  type DeploymentTarget,
  type DeployPlan,
  LORE_DIRECTORY,
  LoreError,
  loadConfig,
} from '@lorepack/core';
import type { CommandContext } from '../framework/context.js';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { runBuild } from '../services/build.js';
import { buildDirectory as localBuildDirectory } from '../services/builds.js';
import {
  type CloudflareResolverAdapter,
  resolveCloudflareTarget,
  resolveCloudflareTargetWithAdapter,
} from '../services/cloudflare-target.js';
import { readReceipt, receiptPath, runDeploy } from '../services/deploy.js';
import { readActiveBuild, readPreviousBuild } from '../services/project.js';
import { readStatus } from '../services/status.js';
import { lockInputs } from '../services/versions.js';

export interface DeployCommandOptions {
  readonly resolveTarget?: (
    name: string,
    input: { readonly projectRoot: string; readonly configPath: string },
  ) => Promise<DeploymentTarget>;
  readonly cloudflareAdapter?: CloudflareResolverAdapter;
  readonly confirm?: (prompt: string, context: CommandContext) => Promise<boolean>;
}

export function deployCommand(options: DeployCommandOptions = {}): CommandDefinition {
  return {
    name: 'deploy',
    description: 'Project a build onto a remote target and activate it after verification.',
    arguments: [{ name: 'target', description: 'which target to deploy to', required: false }],
    flags: [
      { flags: '--dry-run', description: 'show the deploy plan and change nothing remotely' },
      { flags: '--no-build', description: 'refuse when sources are dirty or unbuilt' },
      { flags: '--yes', description: 'apply without asking' },
      { flags: '--resume <receipt-id>', description: 'continue an interrupted deploy' },
      {
        flags: '--allow-capability-loss <capability>',
        description: 'accept one named capability the target cannot serve',
      },
    ],
    handler: async (args, flags, context): Promise<CommandResult> => {
      const config = loadConfig({ cwd: context.options.cwd });
      const targetName = resolveTargetName(args[0]);
      const target =
        options.resolveTarget === undefined
          ? await resolveTarget(
              targetName,
              config.projectRoot,
              config.configPath,
              options.cloudflareAdapter,
            )
          : await options.resolveTarget(targetName, {
              projectRoot: config.projectRoot,
              configPath: config.configPath,
            });
      const resume =
        typeof flags.resume === 'string'
          ? readReceipt(config.projectRoot, flags.resume)
          : undefined;

      if (resume !== undefined && resume.target !== target.id) {
        throw new LoreError(
          'LORE_E_INVALID_ARGUMENT',
          `Receipt ${resume.receiptId} belongs to ${resume.target}, not ${target.id}.`,
          {
            remediation: `Resume with \`lore deploy ${resume.target} --resume ${resume.receiptId}\`, or start a new deploy.`,
            subject: resume.receiptId,
          },
        );
      }

      const preparation = await prepareBuild({
        configRoot: config.projectRoot,
        config,
        flags,
        context,
        ...(resume === undefined ? {} : { resume }),
      });
      const deployPlan = await target.plan({
        projectName: config.config.name,
        buildId: preparation.buildId,
        buildDirectory: preparation.buildDirectory,
        buildCapabilities: preparation.buildCapabilities,
      });
      const planLines = [...preparation.localPlanLines, renderDeployPlan(deployPlan)].filter(
        (line) => line !== '',
      );
      const planText = planLines.join('\n\n');

      if (flags.yes !== true && flags.dryRun !== true) {
        const confirmed = await (options.confirm ?? confirmDeploy)(planText, context);
        if (!confirmed) return { human: `${planText}\n\nCancelled. Nothing was changed.` };
      }

      const accepted = normalizeCapabilityLoss(flags.allowCapabilityLoss);
      const result = await runDeploy({
        target,
        projectRoot: config.projectRoot,
        projectName: config.config.name,
        buildId: preparation.buildId,
        buildDirectory: preparation.buildDirectory,
        buildCapabilities: preparation.buildCapabilities,
        plan: deployPlan,
        progress: context.progress,
        dryRun: flags.dryRun === true,
        ...(resume === undefined ? {} : { resume }),
        ...(accepted.length === 0 ? {} : { allowCapabilityLoss: accepted }),
      }).catch((error: unknown) => {
        const original = LoreError.from(error);
        const receiptId =
          error instanceof LoreError && typeof error.details?.receiptId === 'string'
            ? (error.details.receiptId as string)
            : resume?.receiptId;
        if (receiptId === undefined) throw error;
        throw new LoreError('LORE_E_REMOTE_DEPLOY', original.message, {
          remediation: `${original.remediation ?? 'The previous remote build is still serving.'} Resume with \`lore deploy ${target.id} --resume ${receiptId}\`.`,
          ...(original.details === undefined ? {} : { details: original.details }),
          ...(original.subject === undefined ? {} : { subject: original.subject }),
          ...(original.cause === undefined ? {} : { cause: original.cause }),
        });
      });

      return {
        human: `${planText}\n\n${renderDeployResult(config.projectRoot, result.receipt, result.dryRun)}`,
        json: result.receipt,
      };
    },
  };
}

interface PreparedBuild {
  readonly buildId: BuildId;
  readonly buildDirectory: string;
  readonly buildCapabilities: readonly Capability[];
  readonly localPlanLines: readonly string[];
}

async function prepareBuild(options: {
  readonly configRoot: string;
  readonly config: ReturnType<typeof loadConfig>;
  readonly flags: Record<string, unknown>;
  readonly context: CommandContext;
  readonly resume?: DeploymentReceipt | undefined;
}): Promise<PreparedBuild> {
  if (options.resume !== undefined) {
    return readBuildInputs(options.configRoot, options.resume.buildId as BuildId);
  }

  const status = await readStatus({ config: options.config, progress: options.context.progress });
  const noBuild = options.flags.build === false;
  const needsBuild = status.sourceState === 'dirty' || status.sourceState === 'unbuilt';

  if (needsBuild && noBuild) {
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      'The sources are not already built, and --no-build was given.',
      {
        remediation:
          status.sourceState === 'unbuilt'
            ? 'Run `lore build`, or omit `--no-build` so `lore deploy` can build first.'
            : 'Run `lore build`, or omit `--no-build` so `lore deploy` can rebuild first.',
      },
    );
  }

  const localPlanLines: string[] = [];
  if (needsBuild) {
    const { state, previous } = readPreviousBuild(options.config);
    try {
      const local = await createPlan({
        config: options.config,
        previous,
        previousLock: readLockfile(options.config.projectRoot),
        lockInputs: lockInputs(),
        progress: options.context.progress,
      });
      localPlanLines.push(renderPlan(local.plan));
    } finally {
      state?.close();
    }

    const built = await runBuild({
      config: options.config,
      progress: options.context.progress,
      activate: true,
      ...(options.context.signal === undefined ? {} : { signal: options.context.signal }),
    });
    return {
      ...(readBuildInputs(options.configRoot, built.buildId) as PreparedBuild),
      localPlanLines,
    };
  }

  const active = readActiveBuild(join(options.config.projectRoot, LORE_DIRECTORY));
  if (active === null) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no active build to deploy.', {
      remediation: 'Run `lore build` first, or omit `--no-build` so `lore deploy` can build one.',
    });
  }
  return {
    ...(readBuildInputs(options.configRoot, active.buildId) as PreparedBuild),
    localPlanLines,
  };
}

function readBuildInputs(projectRoot: string, buildId: BuildId): PreparedBuild {
  const loreDirectory = join(projectRoot, LORE_DIRECTORY);
  const buildDirectory = localBuildDirectory(loreDirectory, buildId);
  const manifestPath = join(buildDirectory, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `Build ${buildId} has no manifest.`, {
      remediation: 'Run `lore build` again to recreate it before deploying.',
      subject: buildId,
    });
  }
  const manifest = buildManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  return {
    buildId,
    buildDirectory,
    buildCapabilities: manifest.capabilities,
    localPlanLines: [],
  };
}

function renderDeployPlan(plan: DeployPlan): string {
  const lines = [
    `Target: ${plan.display?.targetLabel ?? plan.target}`,
    `Build:  ${plan.input.buildId}`,
  ];
  if (plan.display === undefined) {
    lines.push(`Capabilities: ${plan.input.buildCapabilities.join(', ')}`);
  }
  lines.push(
    '',
    'Resources',
    ...prefixPlanLines(
      plan.display?.resourceLines ?? ['Resolved by the selected deployment target.'],
    ),
    '',
    'Projection',
    ...prefixPlanLines(
      plan.display?.projectionLines ?? [
        'Project the sealed build as a candidate and verify it before activation.',
      ],
    ),
    '',
    'Activation',
    ...prefixPlanLines(
      plan.display?.activationLines ?? [
        'Switch the active pointer only after candidate verification and smoke confirmation.',
      ],
    ),
  );
  return lines.join('\n');
}

function prefixPlanLines(lines: readonly string[]): readonly string[] {
  return lines.map((line) => `  ${line}`);
}

function renderDeployResult(
  projectRoot: string,
  receipt: DeploymentReceipt,
  dryRun: boolean,
): string {
  if (dryRun) {
    return ['Dry run only. Nothing remote was changed.', `Receipt id: ${receipt.receiptId}`].join(
      '\n',
    );
  }
  return [
    `Deployed ${receipt.buildId} to ${receipt.target}.`,
    `Endpoint: ${receipt.endpoint ?? 'unknown'}`,
    `Active build: ${receipt.buildId}`,
    `Receipt: ${receiptPath(projectRoot, receipt.receiptId)}`,
  ].join('\n');
}

function normalizeCapabilityLoss(raw: unknown): readonly Capability[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map((value) => String(value) as Capability);
  return [String(raw) as Capability];
}

function resolveTargetName(raw: string | undefined): string {
  return raw === undefined || raw.trim() === '' ? 'cloudflare' : raw.trim();
}

async function resolveTarget(
  name: string,
  projectRoot: string,
  _configPath: string,
  cloudflareAdapter?: CloudflareResolverAdapter,
): Promise<DeploymentTarget> {
  if (name !== 'cloudflare') {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `Unknown deploy target ${name}.`, {
      remediation: 'Use `cloudflare`. Additional targets are not implemented in v0.1.',
      subject: name,
    });
  }
  return cloudflareAdapter === undefined
    ? await resolveCloudflareTarget(projectRoot)
    : await resolveCloudflareTargetWithAdapter(projectRoot, cloudflareAdapter);
}

async function confirmDeploy(plan: string, context: CommandContext): Promise<boolean> {
  if (!context.streams.isTty) {
    throw new LoreError(
      'LORE_E_INVALID_ARGUMENT',
      'Deploy confirmation requires a terminal when --yes is not given.',
      {
        remediation: 'Re-run with `--yes` in CI or another non-interactive environment.',
      },
    );
  }

  context.write(`${plan}\n\nDeploy this build? [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => resolve(String(chunk)));
  });
  return /^y(es)?\s*$/i.test(answer.trim());
}
