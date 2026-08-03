import { join, resolve } from 'node:path';
import {
  type ArchiveMember,
  collectBuildMembers,
  collectObjects,
  collectOriginals,
  openReadOnly,
  writeArchive,
} from '@lorepack/backend-local';
import { type BuildId, LORE_DIRECTORY, type LoadedConfig, LoreError } from '@lorepack/core';
import { buildDirectory, openStateStore, resolveBuildId } from './builds.js';

/**
 * Writing a `.lorepack` archive, in the one place both `lore pack` and Studio call.
 *
 * Extracted from the command when Studio grew a pack button (#68). Two implementations of an
 * archive format is how a file packed from a browser ends up subtly different from one packed
 * in a terminal, and the difference would only be discovered by whoever tried to open it.
 */

export interface PackResult {
  readonly buildId: BuildId;
  readonly archive: string;
  /** Members written, including the checksum index. */
  readonly members: number;
  readonly includeOriginals: boolean;
}

export interface PackOptions {
  /** Build id or unique prefix. The active build when omitted. */
  readonly build?: string | undefined;
  /** Where to write. Defaults into the project root, named for the project and the build. */
  readonly out?: string | undefined;
  /** Base for a relative `out`. The process cwd for the CLI, the project root for Studio. */
  readonly relativeTo?: string | undefined;
}

export async function packBuild(config: LoadedConfig, options: PackOptions): Promise<PackResult> {
  const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);
  const state = openStateStore(loreDirectory);

  try {
    const builds = state.listBuilds();
    const active = state.current();
    const buildId =
      options.build === undefined
        ? activeOrFail(active?.buildId)
        : resolveBuildId(builds, options.build);

    const summary = builds.find((build) => build.buildId === buildId);
    if (summary?.state !== 'verified' && summary?.state !== 'active') {
      throw new LoreError(
        'LORE_E_BUILD_VALIDATION',
        `Build ${buildId} is ${summary?.state ?? 'unknown'}, and only a verified build can be packed.`,
        {
          remediation: 'Run `lore build` to produce a verified build.',
          subject: buildId,
        },
      );
    }

    const directory = buildDirectory(loreDirectory, buildId);
    const { objectHashes, sourcePaths } = readReferences(directory);

    const members: ArchiveMember[] = collectBuildMembers(
      directory,
      collectObjects(join(loreDirectory, 'objects'), objectHashes),
    );
    // Originals are excluded by default (section 11.2): an archive is a build, not a copy of
    // someone's document folder, and shipping binaries by default would be a surprise the
    // user did not ask for.
    if (config.effective.includeOriginals) {
      members.push(...collectOriginals(config.projectRoot, sourcePaths));
    }

    const destination =
      options.out === undefined
        ? join(config.projectRoot, `${config.config.name}-${buildId.slice(0, 17)}.lorepack`)
        : resolve(options.relativeTo ?? config.projectRoot, options.out);

    await writeArchive(destination, members);

    return {
      buildId,
      archive: destination,
      members: members.length + 1,
      includeOriginals: config.effective.includeOriginals,
    };
  } finally {
    state.close();
  }
}

function activeOrFail(buildId: BuildId | undefined): BuildId {
  if (buildId === undefined) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no active build to pack.', {
      remediation: 'Run `lore build`, or name a build.',
    });
  }
  return buildId;
}

/** The objects and source paths a build references, read from the build itself. */
function readReferences(directory: string): {
  objectHashes: string[];
  sourcePaths: string[];
} {
  const db = openReadOnly(join(directory, 'context.sqlite'));
  try {
    const rows = db
      .prepare('SELECT object_hash AS objectHash, relative_path AS relativePath FROM artifacts')
      .all() as Array<{ objectHash: string; relativePath: string }>;
    return {
      objectHashes: rows.map((row) => row.objectHash),
      sourcePaths: rows.map((row) => row.relativePath),
    };
  } finally {
    db.close();
  }
}
