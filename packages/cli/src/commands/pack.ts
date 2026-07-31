import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type ArchiveMember,
  collectBuildMembers,
  collectObjects,
  collectOriginals,
  openReadOnly,
  verifyArchive,
  writeArchive,
} from '@lorepack/backend-local';
import { type BuildId, LORE_DIRECTORY, LoreError, loadConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { buildDirectory, openStateStore, resolveBuildId } from '../services/builds.js';

/**
 * `lore pack` writes a `.lorepack` archive: a standard, inspectable ZIP.
 *
 * Nothing about it is clever, and that is the feature. Section 22.3 promises no lock-in,
 * which only means something if a plain `unzip` can open the file without Lorepack.
 */
export function packCommand(): CommandDefinition {
  return {
    name: 'pack',
    description: 'Write a portable .lorepack archive of a build.',
    arguments: [{ name: 'build', description: 'build id or prefix', required: false }],
    flags: [
      { flags: '--verify <file>', description: 'check an existing archive instead of writing one' },
      { flags: '--out <file>', description: 'archive path to write' },
    ],
    handler: async (args, flags, context): Promise<CommandResult> => {
      if (typeof flags.verify === 'string') return verify(flags.verify, context.options.cwd);

      const config = loadConfig({ cwd: context.options.cwd });
      const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);
      const state = openStateStore(loreDirectory);

      try {
        const builds = state.listBuilds();
        const active = state.current();
        const buildId =
          args[0] !== undefined ? resolveBuildId(builds, args[0]) : activeOrFail(active?.buildId);

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
        // Originals are excluded by default (section 11.2): an archive is a build, not a
        // copy of someone's document folder, and shipping binaries by default would be a
        // surprise the user did not ask for.
        if (config.effective.includeOriginals) {
          members.push(...collectOriginals(config.projectRoot, sourcePaths));
        }

        const destination =
          typeof flags.out === 'string'
            ? resolve(context.options.cwd, flags.out)
            : join(config.projectRoot, `${config.config.name}-${buildId.slice(0, 17)}.lorepack`);

        await writeArchive(destination, members);

        return {
          human: `Wrote ${destination}\n  ${members.length + 1} members, including the checksum index.`,
          json: {
            buildId,
            archive: destination,
            members: members.length + 1,
            includeOriginals: config.effective.includeOriginals,
          },
        };
      } finally {
        state.close();
      }
    },
  };
}

async function verify(file: string, cwd: string): Promise<CommandResult> {
  const path = resolve(cwd, file);
  if (!existsSync(path)) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `${file} does not exist.`, {
      remediation: 'Pass the path to a .lorepack archive.',
    });
  }

  const result = await verifyArchive(path);
  if (result.ok) {
    return {
      human: `${path} is intact. ${result.memberCount} members verified.`,
      json: { archive: path, ...result },
    };
  }

  const first = result.failures[0];
  throw new LoreError(
    'LORE_E_OBJECT_CORRUPT',
    `${path} failed verification: ${first?.member} is ${first?.reason}.`,
    {
      remediation: 'Download or pack the archive again. Its contents cannot be trusted.',
      details: { failures: result.failures },
    },
  );
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
