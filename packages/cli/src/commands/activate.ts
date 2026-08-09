import { join } from 'node:path';
import { ProjectLock } from '@lorepack/backend-local';
import {
  type BuildId,
  type BuildSummary,
  type DeploymentTarget,
  LORE_DIRECTORY,
  LoreError,
  loadConfig,
} from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import {
  assertActivatable,
  openStateStore,
  previousBuild,
  resolveBuildId,
} from '../services/builds.js';
import {
  type CloudflareResolverAdapter,
  createWranglerDeployAdapter,
  resolveCloudflareTarget,
  resolveCloudflareTargetWithAdapter,
} from '../services/cloudflare-target.js';
import { readCloudflareTargetReceipt } from './target.js';

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
      switchTo(context.options.cwd, (builds) => resolveBuildId(builds, args[0] ?? ''), 'Activated'),
  };
}

export function rollbackCommand(options: ActivateCommandOptions = {}): CommandDefinition {
  return {
    name: 'rollback',
    description: 'Return to the previous verified build. Never recompiles.',
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
        (builds, active) =>
          args[0] === undefined ? previousBuild(builds, active) : resolveBuildId(builds, args[0]),
        'Rolled back to',
      );
    },
  };
}

export function buildsCommand(): CommandDefinition {
  return {
    name: 'builds',
    description: 'List build history, newest first.',
    handler: (_args, _flags, context): CommandResult => {
      const config = loadConfig({ cwd: context.options.cwd });
      const state = openStateStore(join(config.projectRoot, LORE_DIRECTORY));
      try {
        const builds = state.listBuilds();
        const active = state.current();
        const rows = builds.map((build) => ({
          buildId: build.buildId,
          createdAt: build.createdAt,
          state: build.state,
          active: build.buildId === active?.buildId,
          counts: build.counts,
        }));
        return {
          human: renderBuilds(rows),
          json: { builds: rows, activeBuildId: active?.buildId ?? null },
        };
      } finally {
        state.close();
      }
    },
  };
}

async function switchTo(
  cwd: string,
  choose: (builds: readonly BuildSummary[], active: BuildId | null) => BuildId,
  verb: string,
): Promise<CommandResult> {
  const config = loadConfig({ cwd });
  const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);
  const lock = new ProjectLock(join(loreDirectory, 'lock'));
  const state = openStateStore(loreDirectory);

  try {
    const builds = state.listBuilds();
    const active = state.current();
    const target = choose(builds, active?.buildId ?? null);
    const summary = builds.find((build) => build.buildId === target) as BuildSummary;

    // Pre-flight before the pointer moves. A corrupt build must fail with the previous one
    // still serving, not after it has already been made live.
    assertActivatable(loreDirectory, summary);

    if (active?.buildId === target) {
      return {
        human: `Build ${target} is already active.`,
        json: { buildId: target, generation: active.generation, changed: false },
      };
    }

    // Held only across the pointer change itself, which is one transaction.
    const generation = await lock.withLock(() => state.activate(target));

    return {
      human: `${verb} ${target} (generation ${generation}).`,
      json: { buildId: target, generation, changed: true },
    };
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
  if (builds.length === 0) return 'No builds yet. Run `lore build`.';

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

async function rollbackRemote(
  cwd: string,
  targetName: string,
  buildId: string | undefined,
  resolveTargetOverride: ActivateCommandOptions['resolveTarget'],
  cloudflareAdapter: CloudflareResolverAdapter | undefined,
): Promise<CommandResult> {
  const config = loadConfig({ cwd });
  const requestedBuildId =
    buildId === undefined || buildId.trim() === ''
      ? await previousRemoteBuildId(targetName, config.projectRoot, cloudflareAdapter)
      : (buildId.trim() as BuildId);
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

async function previousRemoteBuildId(
  targetName: string,
  projectRoot: string,
  cloudflareAdapter: CloudflareResolverAdapter | undefined,
): Promise<BuildId> {
  if (targetName !== 'cloudflare') {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `Unknown rollback target ${targetName}.`, {
      remediation:
        'Use `cloudflare`. Additional remote rollback targets are not implemented in v0.1.',
      subject: targetName,
    });
  }

  const receipt = readCloudflareTargetReceipt(projectRoot);
  const adapter = cloudflareAdapter ?? createWranglerDeployAdapter();
  const db = adapter.openCatalogDatabase(receipt.catalogDatabaseName);
  const hasProjectedBuilds = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projected_builds'")
    .run<{ name: string }>();
  if ((hasProjectedBuilds.results?.length ?? 0) === 0) {
    throw new LoreError(
      'LORE_E_BUILD_NOT_FOUND',
      'There is no earlier verified remote build to return to.',
      { remediation: 'Run `lore target status cloudflare` to see the remote history.' },
    );
  }

  const active = await db
    .prepare('SELECT build_id AS buildId FROM active_build WHERE id = 1')
    .run<{ buildId: string | null }>();
  const activeBuildId = active.results?.[0]?.buildId ?? null;
  const projected = await db
    .prepare(
      `SELECT build_id AS buildId, verified_at AS verifiedAt
FROM projected_builds
WHERE project_id = ? AND verified_at IS NOT NULL
ORDER BY verified_at DESC, projected_at DESC, build_id DESC`,
    )
    .bind(receipt.project)
    .run<{ buildId: string; verifiedAt: string }>();
  const previous = (projected.results ?? []).find((row) => row.buildId !== activeBuildId);
  if (previous === undefined) {
    throw new LoreError(
      'LORE_E_BUILD_NOT_FOUND',
      'There is no earlier verified remote build to return to.',
      { remediation: 'Run `lore target status cloudflare` to see the remote history.' },
    );
  }
  return previous.buildId as BuildId;
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
    ? await resolveCloudflareTarget(projectRoot)
    : await resolveCloudflareTargetWithAdapter(projectRoot, cloudflareAdapter);
}
