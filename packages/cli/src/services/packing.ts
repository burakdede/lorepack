import { join, resolve } from 'node:path';
import {
  type ArchiveMember,
  collectBuildMembers,
  collectObjects,
  collectOriginals,
  type OriginalSource,
  openReadOnly,
  writeArchive,
} from '@lorepack/backend-local';
import { type BuildId, LORE_DIRECTORY, type LoadedConfig, LoreError } from '@lorepack/core';
import { buildDirectory, openStateStore, resolveBuildId } from './builds.js';

/**
 * Writing a `.lorepack` archive, in the one place both `lorepack pack` and Studio call.
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
  /** Base for a relative `out`: the process cwd. Only the CLI passes `out`; HTTP cannot. */
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
          remediation: 'Run `lorepack build` to produce a verified build.',
          subject: buildId,
        },
      );
    }

    const directory = buildDirectory(loreDirectory, buildId);
    const { objectHashes, originals } = readReferences(directory);

    const members: ArchiveMember[] = collectBuildMembers(
      directory,
      collectObjects(join(loreDirectory, 'objects'), objectHashes),
    );
    // Originals are excluded by default (section 11.2): an archive is a build, not a copy of
    // someone's document folder, and shipping binaries by default would be a surprise the
    // user did not ask for.
    if (config.effective.includeOriginals) {
      members.push(...collectOriginals(config.projectRoot, originals));
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
      remediation: 'Run `lorepack build`, or name a build.',
    });
  }
  return buildId;
}

/** The objects and original sources a build references, read from the build itself. */
function readReferences(directory: string): {
  objectHashes: string[];
  originals: OriginalSource[];
} {
  const db = openReadOnly(join(directory, 'context.sqlite'));
  try {
    // `display_path`, not `relative_path`: the latter is relative to its source root, so it
    // names the wrong file whenever a source is not the project root.
    const rows = db
      .prepare(
        'SELECT object_hash AS objectHash, display_path AS path, content_hash AS contentHash FROM artifacts',
      )
      .all() as Array<{ objectHash: string; path: string; contentHash: string }>;
    return {
      objectHashes: rows.map((row) => row.objectHash),
      originals: rows.map((row) => ({ path: row.path, contentHash: row.contentHash })),
    };
  } finally {
    db.close();
  }
}
