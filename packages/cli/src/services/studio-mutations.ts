import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectLock } from '@lorepack/backend-local';
import { type BuildId, LORE_DIRECTORY, type LoadedConfig, LoreError } from '@lorepack/core';
import {
  assertActivatable,
  buildDirectory,
  openStateStore,
  previousBuild,
  resolveBuildId,
} from './builds.js';

/**
 * The four things Studio can change, and the boundary that keeps them local.
 *
 * **Model-facing MCP tools stay strictly read-only** (architecture 19.4). These are Studio
 * endpoints: loopback-bound, origin-validated, and never registered on a remote deployment.
 * That separation is the whole reason they live here in the CLI rather than in
 * `@lorepack/runtime`, which also compiles for the Worker: a route that does not exist in
 * that package cannot be exposed by it, however the Worker is configured.
 *
 * Every one of them goes through the same code path the CLI uses, so a build activated from
 * a browser and a build activated from a terminal are the same operation with the same
 * pre-flight and the same lock.
 */

export function createBuildsEndpoint(config: LoadedConfig): () => Promise<unknown> {
  const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);

  return async () => {
    const state = openStateStore(loreDirectory);
    try {
      const active = state.current();
      return {
        activeBuildId: active?.buildId ?? null,
        builds: state.listBuilds().map((build) => ({
          buildId: build.buildId,
          createdAt: build.createdAt,
          state: build.state,
          active: build.buildId === active?.buildId,
          counts: build.counts,
          capabilities: capabilitiesOf(loreDirectory, build.buildId),
        })),
      };
    } finally {
      state.close();
    }
  };
}

/**
 * A build's capabilities, read from its manifest.
 *
 * The manifest is a small JSON file, so this stays a file read per build rather than opening
 * a database per row. `null` rather than an empty list when it cannot be read: a build whose
 * manifest is missing has unknown capabilities, and an empty list would state that it has
 * none, which is a different and false claim.
 */
function capabilitiesOf(loreDirectory: string, buildId: BuildId): readonly string[] | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(buildDirectory(loreDirectory, buildId), 'manifest.json'), 'utf8'),
    ) as { capabilities?: unknown };
    return Array.isArray(manifest.capabilities) ? (manifest.capabilities as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * Moves the active pointer, with the pre-flight that makes it safe.
 *
 * `assertActivatable` runs **before** the pointer moves, so a corrupt build fails with the
 * previous one still serving rather than after it has been made live. Architecture 18.4:
 * activation is a pointer change and never recompiles, which is also why this is quick enough
 * to do from a browser without a progress indicator.
 */
export function createActivateEndpoint(
  config: LoadedConfig,
): (request: unknown) => Promise<unknown> {
  return async (request) => {
    const reference = readBuildReference(request);
    const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);
    const lock = new ProjectLock(join(loreDirectory, 'lock'));
    const state = openStateStore(loreDirectory);

    try {
      const builds = state.listBuilds();
      const target = resolveBuildId(builds, reference);
      const summary = builds.find((build) => build.buildId === target);
      if (summary === undefined) {
        throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No build ${reference}.`, {
          remediation: 'Choose a build from the history on this page.',
          subject: reference,
        });
      }

      assertActivatable(loreDirectory, summary);

      const active = state.current();
      if (active?.buildId === target) {
        return { buildId: target, generation: active.generation, changed: false };
      }

      // Held only across the pointer change itself, which is one transaction.
      const generation = await lock.withLock(() => state.activate(target));
      return { buildId: target, generation, changed: true };
    } finally {
      state.close();
    }
  };
}

/**
 * The previous verified build, chosen the same way `lore rollback` chooses it.
 *
 * Rollback is a pointer change that never recompiles, which is what makes it cheap and safe,
 * and is why Studio does not style it as destructive.
 */
export function createRollbackEndpoint(
  config: LoadedConfig,
): (request: unknown) => Promise<unknown> {
  return async (request) => {
    const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);
    const lock = new ProjectLock(join(loreDirectory, 'lock'));
    const state = openStateStore(loreDirectory);

    try {
      const builds = state.listBuilds();
      const active = state.current();
      const target = previousBuild(builds, active?.buildId ?? null);

      // Studio names the build it is about to return to, and the history can move between
      // rendering that name and confirming it: a rebuild finishing in the next terminal is
      // enough. Rather than silently acting on a different build than the one confirmed, the
      // stale confirmation is refused and the reader gets to look again.
      const expected = (request as { expect?: unknown } | null)?.expect;
      if (typeof expected === 'string' && expected !== target) {
        // An argument that no longer holds, rather than a broken build: the caller can fix
        // this by looking again, which is what separates a 400 from a 500.
        throw new LoreError(
          'LORE_E_INVALID_ARGUMENT',
          'The build history changed while this confirmation was open.',
          {
            remediation: `Rolling back now would return to ${target}, not ${expected}. Check the history and confirm again.`,
            subject: expected,
          },
        );
      }

      const summary = builds.find((build) => build.buildId === target);
      if (summary === undefined) {
        throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'There is no earlier build to return to.', {
          remediation: 'Build again, and this project will have a version to roll back to.',
        });
      }
      assertActivatable(loreDirectory, summary);

      const generation = await lock.withLock(() => state.activate(target));
      return { buildId: target, generation, changed: true };
    } finally {
      state.close();
    }
  };
}

function readBuildReference(request: unknown): string {
  const build = (request as { build?: unknown } | null)?.build;
  if (typeof build !== 'string' || build.trim() === '') {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', 'No build was named.', {
      remediation: 'Send a build id or a unique prefix of one.',
    });
  }
  return build;
}
