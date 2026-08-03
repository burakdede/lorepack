import { join } from 'node:path';
import { ProjectLock } from '@lorepack/backend-local';
import { type BuildId, type BuildSummary, LORE_DIRECTORY, loadConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import {
  assertActivatable,
  openStateStore,
  previousBuild,
  resolveBuildId,
} from '../services/builds.js';

/**
 * Activation and rollback are pointer changes (architecture section 18.4). Neither
 * recompiles anything: rollback that rebuilt would not be a rollback, it would be a build
 * that happens to produce the old answer, and it would fail exactly when the sources that
 * produced the old build are gone.
 */

export function activateCommand(): CommandDefinition {
  return {
    name: 'activate',
    description: 'Point this project at a build. Never recompiles.',
    arguments: [{ name: 'build', description: 'build id or unambiguous prefix' }],
    handler: async (args, _flags, context): Promise<CommandResult> =>
      switchTo(context.options.cwd, (builds) => resolveBuildId(builds, args[0] ?? ''), 'Activated'),
  };
}

export function rollbackCommand(): CommandDefinition {
  return {
    name: 'rollback',
    description: 'Return to the previous verified build. Never recompiles.',
    arguments: [{ name: 'build', description: 'build id or unambiguous prefix', required: false }],
    handler: async (args, _flags, context): Promise<CommandResult> =>
      switchTo(
        context.options.cwd,
        (builds, active) =>
          args[0] === undefined ? previousBuild(builds, active) : resolveBuildId(builds, args[0]),
        'Rolled back to',
      ),
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
