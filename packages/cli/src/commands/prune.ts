import { join } from 'node:path';
import { ProjectLock } from '@lorepack/backend-local';
import {
  count,
  LORE_DIRECTORY,
  LoreError,
  loadConfig,
  type RemoteRetentionReceipt,
} from '@lorepack/core';
import {
  applyRemoteRetentionPlan,
  planRemoteRetention,
  type RemoteRetentionApplyError,
  type RemoteRetentionApplyResult,
  type RemoteRetentionPlan,
  type RemoteRetentionResumeState,
} from '@lorepack/deploy-cloudflare';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { openStateStore } from '../services/builds.js';
import {
  type CloudflareResolverAdapter,
  createWranglerDeployAdapter,
  resolveCloudflareResourcesWithAdapter,
} from '../services/cloudflare-target.js';
import {
  readRemotePruneReceipt,
  remotePruneReceiptId,
  remotePruneReceiptPath,
  writeRemotePruneReceipt,
} from '../services/remote-prune.js';
import {
  applyRetention,
  DEFAULT_KEEP_PREVIOUS,
  planRetention,
  renderRetentionPlan,
} from '../services/retention.js';

export interface PruneCommandOptions {
  readonly cloudflareAdapter?: CloudflareResolverAdapter;
}

export function pruneCommand(options: PruneCommandOptions = {}): CommandDefinition {
  return {
    name: 'prune',
    description: 'Remove old builds, keeping the active one and the previous five.',
    flags: [
      {
        flags: '--keep <count>',
        description: `previous builds to keep (default ${DEFAULT_KEEP_PREVIOUS})`,
      },
      { flags: '--target <target>', description: 'plan cleanup for a remote deployment target' },
      { flags: '--resume <receipt-id>', description: 'continue an interrupted remote cleanup' },
      { flags: '--yes', description: 'apply the plan instead of only printing it' },
    ],
    handler: async (_args, flags, context): Promise<CommandResult> => {
      const targetName =
        typeof flags.target === 'string' && flags.target.trim() !== '' ? flags.target.trim() : null;
      const resumeId =
        typeof flags.resume === 'string' && flags.resume.trim() !== '' ? flags.resume.trim() : null;
      if (resumeId !== null && targetName === null) {
        throw new LoreError(
          'LORE_E_INVALID_ARGUMENT',
          'Remote cleanup resume requires `--target cloudflare`.',
          {
            remediation: 'Run `lore prune --target cloudflare --yes --resume <receipt-id>`.',
            subject: resumeId,
          },
        );
      }
      if (targetName !== null) {
        return await pruneRemote(
          targetName,
          flags.yes === true,
          flags.keep,
          context.options.cwd,
          options.cloudflareAdapter,
          resumeId,
        );
      }
      const config = loadConfig({ cwd: context.options.cwd });
      const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);
      const state = openStateStore(loreDirectory);

      try {
        const keep = parseKeep(flags.keep);
        const plan = planRetention(
          loreDirectory,
          state.listBuilds(),
          state.current()?.buildId ?? null,
          keep,
        );

        // Deletion is never the default. A plan that prints and stops is recoverable; one
        // that deletes because it was run is not.
        if (flags.yes !== true) {
          // Only offer `--yes` when it would do something. Telling a user to re-run a
          // command that has nothing to remove is an instruction to no purpose.
          const next =
            plan.remove.length === 0 ? '' : '\n\nNothing was removed. Re-run with --yes to apply.';
          return {
            human: `${renderRetentionPlan(plan)}${next}`,
            json: { ...plan, applied: false },
          };
        }

        const lock = new ProjectLock(join(loreDirectory, 'lock'));
        await lock.withLock(() => {
          for (const id of plan.remove) state.forgetBuild(id);
          applyRetention(loreDirectory, plan);
        });

        // "Removed." after "Nothing to remove." claimed a deletion that never happened.
        const outcome =
          plan.remove.length === 0
            ? ''
            : `\n\nRemoved ${count(plan.remove.length, 'build')} and ${count(plan.objectsToRemove.length, 'object')}.`;
        return {
          human: `${renderRetentionPlan(plan)}${outcome}`,
          json: { ...plan, applied: true },
        };
      } finally {
        state.close();
      }
    },
  };
}

function parseKeep(raw: unknown): number {
  if (raw === undefined) return DEFAULT_KEEP_PREVIOUS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `--keep must be a whole number, got ${raw}.`, {
      remediation: 'Pass a count, for example `--keep 10`.',
    });
  }
  return value;
}

async function pruneRemote(
  targetName: string,
  apply: boolean,
  keepRaw: unknown,
  cwd: string,
  cloudflareAdapter: CloudflareResolverAdapter | undefined,
  resumeId: string | null,
): Promise<CommandResult> {
  if (targetName !== 'cloudflare') {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `Unknown prune target ${targetName}.`, {
      remediation: 'Use `cloudflare`. Additional remote prune targets are not implemented in v0.1.',
      subject: targetName,
    });
  }
  if (resumeId !== null && !apply) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', 'Remote cleanup resume requires `--yes`.', {
      remediation: 'Run `lore prune --target cloudflare --yes --resume <receipt-id>`.',
      subject: resumeId,
    });
  }

  const config = loadConfig({ cwd });
  if (resumeId !== null) {
    return await resumeRemotePrune(
      config.projectRoot,
      keepRaw,
      resumeId,
      cloudflareAdapter ?? createWranglerDeployAdapter(),
    );
  }

  const resolved = await resolveCloudflareResourcesWithAdapter(
    config.projectRoot,
    cloudflareAdapter ?? createWranglerDeployAdapter(),
  );
  const keep = parseKeep(keepRaw);
  if (!apply) {
    const plan = await planRemoteRetention(resolved.catalogDb, resolved.receipt.project, keep);
    return {
      human: renderRemoteRetentionPlan(plan),
      json: {
        target: 'cloudflare',
        applied: false,
        ...plan,
      },
    };
  }

  const plan = await planRemoteRetention(resolved.catalogDb, resolved.receipt.project, keep);
  if (plan.remove.length === 0) {
    return {
      human: `Nothing to remove remotely. ${count(plan.keep.length, 'build')} retained.`,
      json: {
        target: 'cloudflare',
        applied: true,
        ...zeroRemovalResult(plan),
      },
    };
  }

  const receipt = createRemotePruneReceipt(resolved.receipt.project, keep, plan);
  return await applyRemotePruneWithReceipt(
    config.projectRoot,
    receipt,
    resolved.catalogDb,
    resolved.objects,
  );
}

function renderRemoteRetentionPlan(plan: {
  readonly keep: readonly string[];
  readonly remove: readonly string[];
  readonly archiveKeysToRemove: readonly string[];
  readonly objectKeysToRemove: readonly string[];
}): string {
  if (plan.remove.length === 0) {
    return `Nothing to remove remotely. ${count(plan.keep.length, 'build')} retained.`;
  }

  const lines = [
    `Cloudflare cleanup plan: removing ${count(plan.remove.length, 'remote build')}, keeping ${plan.keep.length}:`,
    '',
  ];
  for (const buildId of plan.remove) lines.push(`  - ${buildId}`);
  lines.push('');
  lines.push(`  ${count(plan.archiveKeysToRemove.length, 'build archive')}`);
  lines.push(`  ${count(plan.objectKeysToRemove.length, 'unreferenced object')}`);
  lines.push('');
  lines.push('Nothing was removed. Re-run with --yes to apply.');
  return lines.join('\n');
}

function renderRemoteRetentionApplyResult(result: RemoteRetentionApplyResult): string {
  if (result.remove.length === 0) {
    return `Nothing to remove remotely. ${count(result.keep.length, 'build')} retained.`;
  }

  const lines = [
    `Cloudflare cleanup applied: removed ${count(result.remove.length, 'remote build')}, kept ${result.keep.length}.`,
    '',
    `D1 rows removed: ${renderD1Counts(result)}`,
    `R2 objects removed: ${count(result.r2.archiveKeysRemoved.length, 'build archive')} and ${count(result.r2.objectKeysRemoved.length, 'unreferenced object')}.`,
  ];

  if (result.d1.physicalTablesDropped.length > 0) {
    lines.push(`Dropped ${count(result.d1.physicalTablesDropped.length, 'physical table')}.`);
  }

  return lines.join('\n');
}

async function resumeRemotePrune(
  projectRoot: string,
  keepRaw: unknown,
  resumeId: string,
  cloudflareAdapter: CloudflareResolverAdapter,
): Promise<CommandResult> {
  const receipt = readRemotePruneReceipt(projectRoot, resumeId);
  if (keepRaw !== undefined) {
    const keep = parseKeep(keepRaw);
    if (keep !== receipt.keepPrevious) {
      throw new LoreError(
        'LORE_E_INVALID_ARGUMENT',
        `Receipt ${resumeId} was created with --keep ${receipt.keepPrevious}, not ${keep}.`,
        {
          remediation:
            'Resume with the original keep count, or start a fresh cleanup from the beginning.',
          subject: resumeId,
        },
      );
    }
  }
  if (receipt.state === 'applied') {
    return {
      human: renderRemoteRetentionApplyResult(resultFromReceipt(receipt)),
      json: {
        target: 'cloudflare',
        receiptId: receipt.receiptId,
        applied: true,
        ...resultFromReceipt(receipt),
      },
    };
  }

  const resolved = await resolveCloudflareResourcesWithAdapter(projectRoot, cloudflareAdapter);
  if (resolved.receipt.project !== receipt.project) {
    throw new LoreError(
      'LORE_E_TARGET_NOT_CONFIGURED',
      `Receipt ${resumeId} belongs to project ${receipt.project}, but the current Cloudflare target receipt points at ${resolved.receipt.project}.`,
      {
        remediation:
          'Restore the matching Cloudflare target receipt or restart cleanup against the current target.',
        subject: resumeId,
      },
    );
  }

  return await applyRemotePruneWithReceipt(
    projectRoot,
    receipt,
    resolved.catalogDb,
    resolved.objects,
  );
}

async function applyRemotePruneWithReceipt(
  projectRoot: string,
  receipt: RemoteRetentionReceipt,
  catalogDb: Parameters<typeof planRemoteRetention>[0],
  objects: CloudflareResolverAdapter['openObjectsBucket'] extends (...args: never[]) => infer T
    ? T
    : never,
): Promise<CommandResult> {
  const applyingReceipt: RemoteRetentionReceipt = {
    ...receipt,
    state: 'applying',
  };
  writeRemotePruneReceipt(projectRoot, applyingReceipt);

  try {
    const result = await applyRemoteRetentionPlan(
      catalogDb,
      objects,
      receipt.plan as RemoteRetentionPlan,
      resumeStateFromReceipt(receipt),
    );
    const finished: RemoteRetentionReceipt = {
      ...receipt,
      state: 'applied',
      completedSteps: ['plan', 'd1', 'archives', 'objects'],
      d1: cloneD1Report(result.d1),
      r2: cloneR2Report(result.r2),
    };
    writeRemotePruneReceipt(projectRoot, finished);
    return {
      human: `${renderRemoteRetentionApplyResult(result)}\nReceipt: ${remotePruneReceiptPath(projectRoot, finished.receiptId)}`,
      json: {
        target: 'cloudflare',
        receiptId: finished.receiptId,
        applied: true,
        ...result,
      },
    };
  } catch (error) {
    const failed = receiptForFailure(receipt, error as RemoteRetentionApplyError);
    writeRemotePruneReceipt(projectRoot, failed);
    throw new LoreError(
      'LORE_E_REMOTE_DEPLOY',
      `Cloudflare cleanup failed while removing ${count(receipt.plan.remove.length, 'remote build')}.`,
      {
        remediation: `Completed cleanup work was recorded. Resume with \`lore prune --target cloudflare --yes --resume ${receipt.receiptId}\`.`,
        details: { receiptId: receipt.receiptId },
        cause: error,
      },
    );
  }
}

function renderD1Counts(result: RemoteRetentionApplyResult): string {
  return [
    `${count(result.d1.projectedBuildsRemoved, 'projected build')}`,
    `${count(result.d1.buildManifestsRemoved, 'manifest')}`,
    `${count(result.d1.buildWarningsRemoved, 'warning')}`,
    `${count(result.d1.artifactsRemoved, 'artifact')}`,
    `${count(result.d1.supersessionsRemoved, 'supersession')}`,
    `${count(result.d1.nodesRemoved, 'node')}`,
    `${count(result.d1.chunksRemoved, 'chunk')}`,
    `${count(result.d1.ftsRowsRemoved, 'fts row')}`,
    `${count(result.d1.projectedTablesRemoved, 'projected table')}`,
    `${count(result.d1.projectedTableColumnsRemoved, 'projected table column')}`,
  ].join(', ');
}

function createRemotePruneReceipt(
  project: string,
  keepPrevious: number,
  plan: RemoteRetentionPlan,
): RemoteRetentionReceipt {
  return {
    formatVersion: 1,
    receiptId: remotePruneReceiptId(plan.activeBuildId ?? plan.keep[0] ?? plan.remove[0] ?? null),
    target: 'cloudflare',
    project,
    keepPrevious,
    createdAt: new Date().toISOString(),
    state: 'planned',
    completedSteps: ['plan'],
    plan: clonePlanForReceipt(plan),
    d1: cloneD1Report(zeroRemovalResult(plan).d1),
    r2: cloneR2Report(zeroRemovalResult(plan).r2),
  };
}

function zeroRemovalResult(plan: RemoteRetentionPlan): RemoteRetentionApplyResult {
  return {
    ...plan,
    d1: {
      projectedBuildsRemoved: 0,
      buildManifestsRemoved: 0,
      buildWarningsRemoved: 0,
      artifactsRemoved: 0,
      supersessionsRemoved: 0,
      nodesRemoved: 0,
      chunksRemoved: 0,
      ftsRowsRemoved: 0,
      projectedTablesRemoved: 0,
      projectedTableColumnsRemoved: 0,
      physicalTablesDropped: [],
    },
    r2: {
      archiveKeysRemoved: [],
      objectKeysRemoved: [],
    },
  };
}

function resumeStateFromReceipt(receipt: RemoteRetentionReceipt): RemoteRetentionResumeState {
  return {
    d1Completed: receipt.completedSteps.includes('d1'),
    archivesCompleted: receipt.completedSteps.includes('archives'),
    objectsCompleted: receipt.completedSteps.includes('objects'),
    d1: receipt.d1,
    archiveKeysRemoved: receipt.r2.archiveKeysRemoved,
    objectKeysRemoved: receipt.r2.objectKeysRemoved,
  };
}

function resultFromReceipt(receipt: RemoteRetentionReceipt): RemoteRetentionApplyResult {
  return {
    activeBuildId: receipt.plan.activeBuildId as RemoteRetentionPlan['activeBuildId'],
    keep: [...receipt.plan.keep] as RemoteRetentionPlan['keep'],
    remove: [...receipt.plan.remove] as RemoteRetentionPlan['remove'],
    archiveKeysToRemove: [...receipt.plan.archiveKeysToRemove],
    objectKeysToRemove: [...receipt.plan.objectKeysToRemove],
    d1: cloneD1Report(receipt.d1),
    r2: cloneR2Report(receipt.r2),
  };
}

function receiptForFailure(
  receipt: RemoteRetentionReceipt,
  error: RemoteRetentionApplyError,
): RemoteRetentionReceipt {
  return {
    ...receipt,
    state: 'failed',
    completedSteps: completedStepsFromResumeState(error.progress),
    d1: cloneD1Report(error.progress.d1),
    r2: cloneR2Report({
      archiveKeysRemoved: error.progress.archiveKeysRemoved,
      objectKeysRemoved: error.progress.objectKeysRemoved,
    }),
  };
}

function completedStepsFromResumeState(
  state: RemoteRetentionResumeState,
): RemoteRetentionReceipt['completedSteps'] {
  const completed: RemoteRetentionReceipt['completedSteps'] = ['plan'];
  if (state.d1Completed) completed.push('d1');
  if (state.archivesCompleted) completed.push('archives');
  if (state.objectsCompleted) completed.push('objects');
  return completed;
}

function clonePlanForReceipt(plan: RemoteRetentionPlan): RemoteRetentionReceipt['plan'] {
  return {
    activeBuildId: plan.activeBuildId,
    keep: [...plan.keep],
    remove: [...plan.remove],
    archiveKeysToRemove: [...plan.archiveKeysToRemove],
    objectKeysToRemove: [...plan.objectKeysToRemove],
  };
}

function cloneD1Report(report: RemoteRetentionApplyResult['d1']): RemoteRetentionReceipt['d1'] {
  return {
    ...report,
    physicalTablesDropped: [...report.physicalTablesDropped],
  };
}

function cloneR2Report(report: RemoteRetentionApplyResult['r2']): RemoteRetentionReceipt['r2'] {
  return {
    archiveKeysRemoved: [...report.archiveKeysRemoved],
    objectKeysRemoved: [...report.objectKeysRemoved],
  };
}
