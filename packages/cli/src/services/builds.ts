import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertIdentifier,
  decodeValue,
  LocalStateStore,
  openReadOnly,
  stateMigrationsDirectory,
  tableLocator,
} from '@lorepack/backend-local';
import type { BuildSnapshot } from '@lorepack/compiler';
import {
  assertBuildId,
  type BuildId,
  type BuildSummary,
  buildManifestSchema,
  type ColumnTypeName,
  count,
  LoreError,
  objectKey,
  type TableValue,
} from '@lorepack/core';

/**
 * Reading sealed builds: history, resolution of a short id, and the snapshot the diff
 * engine works on.
 *
 * Everything here reads build data only. Nothing re-parses a source, which is what lets
 * `lorepack diff` and `lorepack rollback` work in a project whose source directory has been
 * deleted, and what makes both operations instant.
 */

export function openStateStore(loreDirectory: string): LocalStateStore {
  if (!existsSync(join(loreDirectory, 'state.sqlite'))) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no builds yet.', {
      remediation: 'Run `lorepack build` to create the first one.',
    });
  }
  return LocalStateStore.open(loreDirectory, stateMigrationsDirectory());
}

/**
 * Resolves a full id or an unambiguous prefix.
 *
 * An ambiguous prefix lists the candidates rather than picking one. Silently choosing
 * would mean activating a build the user did not name.
 */
export function resolveBuildId(builds: readonly BuildSummary[], reference: string): BuildId {
  const needle = reference.trim();
  if (needle === '') {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', 'No build was named.', {
      remediation: 'Pass a build id, or run `lorepack builds` to list them.',
    });
  }

  const exact = builds.find((build) => build.buildId === needle);
  if (exact !== undefined) return exact.buildId;

  const matches = builds.filter((build) => build.buildId.startsWith(needle));
  if (matches.length === 1) return (matches[0] as BuildSummary).buildId;

  if (matches.length === 0) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No build matches ${needle}.`, {
      remediation:
        builds.length === 0
          ? 'Run `lorepack build` to create one.'
          : `Available builds:\n${builds.map((build) => `  ${build.buildId}`).join('\n')}`,
      subject: needle,
    });
  }

  throw new LoreError(
    'LORE_E_INVALID_ARGUMENT',
    `${needle} matches ${count(matches.length, 'build')}.`,
    {
      remediation: `Use a longer prefix. Candidates:\n${matches
        .map((build) => `  ${build.buildId}`)
        .join('\n')}`,
      subject: needle,
    },
  );
}

/**
 * The build a rollback returns to: the newest activatable one that is not already live.
 *
 * One definition, used by `lorepack rollback` and by the Studio endpoint behind the same button,
 * because two definitions is how a terminal and a browser end up returning to different
 * builds from the same history.
 */
export function previousBuild(builds: readonly BuildSummary[], active: BuildId | null): BuildId {
  const candidates = builds.filter(
    (build) => build.buildId !== active && (build.state === 'verified' || build.state === 'active'),
  );
  const previous = candidates[0];
  if (previous === undefined) {
    throw new LoreError(
      'LORE_E_BUILD_NOT_FOUND',
      'There is no earlier verified build to return to.',
      { remediation: 'Run `lorepack builds` to see the history.' },
    );
  }
  return previous.buildId;
}

export function buildDirectory(loreDirectory: string, buildId: BuildId): string {
  return join(loreDirectory, 'builds', buildId);
}

/** Reads the canonical records a diff compares, straight out of the sealed build. */
export function readSnapshot(loreDirectory: string, buildId: BuildId): BuildSnapshot {
  const directory = buildDirectory(loreDirectory, buildId);
  const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `Build ${buildId} has no manifest.`, {
      remediation: 'The build directory is incomplete. Rebuild, or activate another build.',
      subject: buildId,
    });
  }

  const manifest = buildManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const db = openReadOnly(join(directory, 'context.sqlite'));
  try {
    const artifacts = db
      .prepare(
        'SELECT id, relative_path, content_hash, status, authority FROM artifacts ORDER BY id',
      )
      .all() as Array<{
      id: string;
      relative_path: string;
      content_hash: string;
      status: string;
      authority: number;
    }>;

    const supersessions = db
      .prepare('SELECT artifact_id, superseded_id FROM supersessions')
      .all() as Array<{ artifact_id: string; superseded_id: string }>;
    const superseded = new Map<string, string[]>();
    for (const row of supersessions) {
      const list = superseded.get(row.artifact_id) ?? [];
      list.push(row.superseded_id);
      superseded.set(row.artifact_id, list);
    }

    const chunks = db.prepare('SELECT id, revision_hash FROM chunks ORDER BY id').all() as Array<{
      id: string;
      revision_hash: string;
    }>;

    const tableRows = db
      .prepare(
        'SELECT id, artifact_id, name, sheet, sql_name, row_count, relative_path, line_start, line_end, cell_range FROM tables ORDER BY id',
      )
      .all() as Array<{
      id: string;
      artifact_id: string;
      name: string;
      sheet: string | null;
      sql_name: string;
      row_count: number;
      relative_path: string;
      line_start: number | null;
      line_end: number | null;
      cell_range: string | null;
    }>;
    const tables = tableRows.map((table) => {
      const columns = db
        .prepare(
          'SELECT ordinal, name, sql_name, type FROM table_columns WHERE table_id = ? ORDER BY ordinal',
        )
        .all(table.id) as Array<{ ordinal: number; name: string; sql_name: string; type: string }>;
      const physical = assertIdentifier(table.sql_name);
      const rows = db.prepare(`SELECT * FROM ${physical}`).all() as Array<Record<string, unknown>>;
      return {
        tableId: table.id,
        name: table.name,
        rows: table.row_count,
        columns: columns.map((column) => column.name),
        locator: tableLocator(table),
        cells: rows.flatMap((row, rowIndex) =>
          columns.map((column) => ({
            row: rowIndex,
            column: column.name,
            value: decodeValue(row[column.sql_name], column.type as ColumnTypeName) as TableValue,
          })),
        ),
      };
    });

    return {
      buildId,
      formatVersion: manifest.formatVersion,
      schemaVersion: manifest.schemaVersion,
      compilerVersion: manifest.compilerVersion,
      configurationHash: manifest.configurationHash,
      capabilities: manifest.capabilities,
      canonicalRoots: manifest.canonicalRoots,
      artifacts: artifacts.map((row) => ({
        id: row.id,
        relativePath: row.relative_path,
        contentHash: row.content_hash,
        status: row.status,
        authority: Number(row.authority),
        supersedes: superseded.get(row.id) ?? [],
      })),
      chunks: chunks.map((row) => ({ id: row.id, revisionHash: row.revision_hash })),
      tables,
    };
  } finally {
    db.close();
  }
}

/**
 * Pre-flight before a pointer change: the build exists, passed validation, its database
 * opens, its integrity check passes, and every object it references is present.
 *
 * Activation is cheap, but activating a corrupt build is not, so the check happens before
 * the pointer moves rather than at the first request that fails.
 */
export function assertActivatable(loreDirectory: string, build: BuildSummary): void {
  if (build.state !== 'verified' && build.state !== 'active') {
    throw new LoreError(
      'LORE_E_BUILD_VALIDATION',
      `Build ${build.buildId} is ${build.state}, and only a verified build may be activated.`,
      {
        remediation: 'Activate a build that passed validation, or run `lorepack build` again.',
        subject: build.buildId,
      },
    );
  }

  const databasePath = join(buildDirectory(loreDirectory, build.buildId), 'context.sqlite');
  if (!existsSync(databasePath)) {
    throw new LoreError(
      'LORE_E_BUILD_NOT_FOUND',
      `Build ${build.buildId} is recorded but its files are missing.`,
      {
        remediation: 'Run `lorepack build` to recreate it. The active build is unchanged.',
        subject: build.buildId,
      },
    );
  }

  const db = openReadOnly(databasePath);
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: string }>;
    const problems = rows
      .map((row) => row.integrity_check ?? '')
      .filter((value) => value !== '' && value !== 'ok');
    if (problems.length > 0) {
      throw new LoreError(
        'LORE_E_OBJECT_CORRUPT',
        `Build ${build.buildId} failed its integrity check: ${problems.join('; ')}`,
        {
          remediation:
            'Run `lorepack build` to produce a fresh build. The active build is unchanged.',
          subject: build.buildId,
        },
      );
    }

    // A sound database can still point at normalized bodies that are gone, and such a build
    // fails at its first source read or pack (#564). Presence is checked, not checksums:
    // every read verifies the bytes, and hashing every object would make activation slow.
    const hashes = db.prepare('SELECT DISTINCT object_hash FROM artifacts').all() as Array<{
      object_hash: string;
    }>;
    const missing = hashes
      .map((row) => row.object_hash)
      .filter((hash) => !existsSync(join(loreDirectory, 'objects', ...objectKey(hash).split('/'))));
    if (missing.length > 0) {
      throw new LoreError(
        'LORE_E_OBJECT_CORRUPT',
        `Build ${build.buildId} references ${count(missing.length, 'object')} that ${missing.length === 1 ? 'is' : 'are'} missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', ...' : ''}`,
        {
          remediation:
            'Run `lorepack build` to restore the objects from the sources. The active build is unchanged.',
          subject: build.buildId,
          details: { missing },
        },
      );
    }
  } finally {
    db.close();
  }
}

export { assertBuildId };
