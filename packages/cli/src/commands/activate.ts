import { join } from 'node:path';
import { ProjectLock } from '@lorepack/backend-local';
import {
  assertBuildId,
  type BuildHistorySnapshot,
  type BuildId,
  type DeploymentTarget,
  LORE_DIRECTORY,
  LoreError,
  loadProjectConfig,
} from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import {
  assertActivatable,
  openStateStore,
  previousBuild,
  resolveBuildId,
  rollbackStatus,
} from '../services/builds.js';
import {
  type CloudflareResolverAdapter,
  resolveCloudflareTarget,
  resolveCloudflareTargetWithAdapter,
} from '../services/cloudflare-target.js';

/**
 * Activation and rollback are pointer changes (architecture section 18.4). Neither
 * recompiles anything: rollback that rebuilt would not be a rollback, it would be a build
 * that happens to produce the old answer, and it would fail exactly when the sources that
 * produced the old build are gone.
 */

export interface ActivateCommandOptions {
  readonly resolveTarget?: (
    name: string,
    input: { readonly projectRoot: string; readonly configPath: string },
  ) => Promise<DeploymentTarget>;
  readonly cloudflareAdapter?: CloudflareResolverAdapter;
}

export function activateCommand(): CommandDefinition {
  return {
    name: 'activate',
    description: 'Point this project at a build. Never recompiles.',
    arguments: [{ name: 'build', description: 'build id or unambiguous prefix' }],
    handler: async (args, _flags, context): Promise<CommandResult> =>
      switchTo(
        context.options.cwd,
        (history) => resolveBuildId(history.builds, args[0] ?? ''),
        'Activated',
      ),
  };
}

export function rollbackCommand(options: ActivateCommandOptions = {}): CommandDefinition {
  return {
    name: 'rollback',
    description: 'Return to the previously active build. Never recompiles.',
    arguments: [{ name: 'build', description: 'build id or unambiguous prefix', required: false }],
    flags: [{ flags: '--target <target>', description: 'roll back a remote deployment target' }],
    handler: async (args, flags, context): Promise<CommandResult> => {
      const targetName =
        typeof flags.target === 'string' && flags.target.trim() !== '' ? flags.target.trim() : null;
      if (targetName !== null) {
        return await rollbackRemote(
          context.options.cwd,
          targetName,
          args[0],
          options.resolveTarget,
          options.cloudflareAdapter,
        );
      }
      return await switchTo(
        context.options.cwd,
        (history) =>
          args[0] === undefined ? previousBuild(history) : resolveBuildId(history.builds, args[0]),
        'Rolled back to',
      );
    },
  };
}

export function buildsCommand(): CommandDefinition {
  return {
    name: 'builds',
    description: 'List build history, newest first.',
    flags: [
      {
        flags: '--activations',
        description: 'show recorded activation events instead of build creation order',
      },
    ],
    handler: (_args, flags, context): CommandResult => {
      const config = loadProjectConfig({ cwd: context.options.cwd });
      const state = openStateStore(join(config.projectRoot, LORE_DIRECTORY));
      try {
        const history = state.history();
        const active = history.active;
        const rows = history.builds.map((build) => ({
          buildId: build.buildId,
          createdAt: build.createdAt,
          state: build.state,
          active: build.buildId === active?.buildId,
          counts: build.counts,
        }));
        return {
          human: flags.activations === true ? renderActivations(history) : renderBuilds(rows),
          json: {
            builds: rows,
            activeBuildId: active?.buildId ?? null,
            activationHistory: history.activationHistory,
            historyTruncated: history.historyTruncated,
            ...rollbackStatus(history),
          },
        };
      } finally {
        state.close();
      }
    },
  };
}

async function switchTo(
  cwd: string,
  choose: (history: BuildHistorySnapshot) => BuildId,
  verb: string,
): Promise<CommandResult> {
  const config = loadProjectConfig({ cwd });
  const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);
  const lock = new ProjectLock(join(loreDirectory, 'lock'));
  const state = openStateStore(loreDirectory);

  try {
    return await lock.withLock(() => {
      const history = state.history();
      const target = choose(history);
      const summary = history.builds.find((build) => build.buildId === target);
      if (summary === undefined) {
        throw new LoreError('LORE_E_BUILD_NOT_FOUND', `Build ${target} is no longer retained.`, {
          remediation: 'Select a retained verified build. The active build is unchanged.',
          subject: target,
        });
      }
      assertActivatable(loreDirectory, summary);
      if (history.active?.buildId === target) {
        return {
          human: `Build ${target} is already active.`,
          json: { buildId: target, generation: history.active.generation, changed: false },
        };
      }
      const generation = state.activate(target);
      return {
        human: `${verb} ${target} (generation ${generation}).`,
        json: { buildId: target, generation, changed: true },
      };
    });
  } finally {
    state.close();
  }
}

interface BuildRow {
  readonly buildId: BuildId;
  readonly createdAt: string;
  readonly state: string;
  readonly active: boolean;
  readonly counts: { artifacts: number; chunks: number };
}

function renderBuilds(builds: readonly BuildRow[]): string {
  if (builds.length === 0) return 'No builds yet. Run `lorepack build`.';

  const lines = ['  BUILD              CREATED               ARTIFACTS  CHUNKS  STATE'];
  for (const build of builds) {
    const marker = build.active ? '*' : ' ';
    lines.push(
      `${marker} ${build.buildId.slice(0, 17)}  ${build.createdAt.slice(0, 19)}  ` +
        `${String(build.counts.artifacts).padStart(9)}  ${String(build.counts.chunks).padStart(6)}  ${build.state}`,
    );
  }
  lines.push('', '* active');
  return lines.join('\n');
}

function renderActivations(history: BuildHistorySnapshot): string {
  if (history.activationHistory.length === 0) return 'No activation events are recorded yet.';
  const lines = ['Activation history (newest first):'];
  for (const event of history.activationHistory) {
    const previous =
      event.previousBuildId?.slice(0, 17) ?? (event.kind === 'baseline' ? 'unknown' : 'none');
    lines.push(
      `${event.generation}  ${event.kind === 'baseline' ? 'Observed active' : 'Activated'} ${event.buildId.slice(0, 17)}  from ${previous}  ${event.recordedAt}`,
    );
  }
  if (history.historyTruncated) lines.push('Earlier recorded events are not shown.');
  if (history.activationHistory.some((event) => event.kind === 'baseline')) {
    lines.push('Baseline observations do not establish earlier activation history.');
  }
  return lines.join('\n');
}

async function rollbackRemote(
  cwd: string,
  targetName: string,
  buildId: string | undefined,
  resolveTargetOverride: ActivateCommandOptions['resolveTarget'],
  cloudflareAdapter: CloudflareResolverAdapter | undefined,
): Promise<CommandResult> {
  const config = loadProjectConfig({ cwd });
  const requestedBuildId =
    buildId === undefined || buildId.trim() === '' ? undefined : assertBuildId(buildId.trim());
  const target =
    resolveTargetOverride === undefined
      ? await resolveRemoteTarget(
          targetName,
          config.projectRoot,
          config.configPath,
          cloudflareAdapter,
        )
      : await resolveTargetOverride(targetName, {
          projectRoot: config.projectRoot,
          configPath: config.configPath,
        });

  const activation = await target.rollback(requestedBuildId);
  return {
    human: [
      `Rolled back ${target.id} to ${activation.buildId}.`,
      `Endpoint: ${activation.endpoint ?? 'unknown'}`,
      `Active build: ${activation.buildId}`,
    ].join('\n'),
    json: {
      buildId: activation.buildId,
      previousBuildId: activation.previousBuildId,
      confirmedBuildId: activation.confirmedBuildId,
      endpoint: activation.endpoint,
      changed: true,
    },
  };
}

async function resolveRemoteTarget(
  name: string,
  projectRoot: string,
  _configPath: string,
  cloudflareAdapter?: CloudflareResolverAdapter,
): Promise<DeploymentTarget> {
  if (name !== 'cloudflare') {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `Unknown rollback target ${name}.`, {
      remediation:
        'Use `cloudflare`. Additional remote rollback targets are not implemented in v0.1.',
      subject: name,
    });
  }
  return cloudflareAdapter === undefined
    ? await resolveCloudflareTarget(projectRoot, { requireEndpoint: false })
    : await resolveCloudflareTargetWithAdapter(projectRoot, cloudflareAdapter, {
        requireEndpoint: false,
      });
}
