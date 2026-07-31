import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openReadOnly } from '@lorepack/backend-local';
import {
  type BuildId,
  buildManifestSchema,
  LORE_DIRECTORY,
  LoreError,
  loadConfig,
} from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { buildDirectory, openStateStore, resolveBuildId } from '../services/builds.js';

/**
 * `lore inspect` makes every compiler decision visible without re-running the build.
 *
 * One command with subjects rather than five verbs, and every subject reads sealed build
 * data only. Nothing here re-parses, so inspection is fast, works on any retained build,
 * and keeps working after the sources are gone. That is what "transparent magic"
 * (architecture section 4.9) has to mean to be worth anything.
 */

const SUBJECTS = ['warnings', 'sources', 'build', 'chunks', 'builds'] as const;
type Subject = (typeof SUBJECTS)[number];

export function inspectCommand(): CommandDefinition {
  return {
    name: 'inspect',
    description: `Show what the build contains. Subjects: ${SUBJECTS.join(', ')}, or a source path.`,
    arguments: [
      { name: 'subject', description: `one of ${SUBJECTS.join(', ')}, or a source path` },
      {
        name: 'target',
        description: 'path or build id, depending on the subject',
        required: false,
      },
    ],
    flags: [{ flags: '--build <id>', description: 'inspect a build other than the active one' }],
    handler: (args, flags, context): CommandResult => {
      const config = loadConfig({ cwd: context.options.cwd });
      const loreDirectory = join(config.projectRoot, LORE_DIRECTORY);
      const state = openStateStore(loreDirectory);

      try {
        const builds = state.listBuilds();
        const active = state.current();
        const subject = (args[0] ?? '') as Subject | string;

        const requested = typeof flags.build === 'string' ? flags.build : undefined;
        const buildId =
          requested !== undefined
            ? resolveBuildId(builds, requested)
            : subject === 'build' && args[1] !== undefined
              ? resolveBuildId(builds, args[1])
              : activeOrFail(active?.buildId);

        switch (subject) {
          case 'warnings':
            return inspectWarnings(loreDirectory, buildId);
          case 'build':
            return inspectBuild(loreDirectory, buildId, active?.buildId ?? null);
          case 'sources':
            return inspectSources(loreDirectory, buildId);
          case 'builds':
            return {
              human: 'Run `lore builds` for build history.',
              json: { builds: builds.map((build) => build.buildId) },
            };
          case 'chunks':
            return inspectChunks(loreDirectory, buildId, args[1] ?? '');
          default:
            // Anything else is treated as a source path, which is the common case and
            // saves typing `lore inspect sources <path>`.
            return inspectArtifact(loreDirectory, buildId, subject);
        }
      } finally {
        state.close();
      }
    },
  };
}

function activeOrFail(buildId: BuildId | undefined): BuildId {
  if (buildId === undefined) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no active build.', {
      remediation: 'Run `lore build`, or pass `--build <id>`.',
    });
  }
  return buildId;
}

function withDatabase<T>(
  loreDirectory: string,
  buildId: BuildId,
  read: (db: import('node:sqlite').DatabaseSync) => T,
): T {
  const path = join(buildDirectory(loreDirectory, buildId), 'context.sqlite');
  if (!existsSync(path)) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `Build ${buildId} has no database.`, {
      remediation: 'Run `lore build` to recreate it.',
      subject: buildId,
    });
  }
  const db = openReadOnly(path);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function inspectWarnings(loreDirectory: string, buildId: BuildId): CommandResult {
  const warnings = withDatabase(
    loreDirectory,
    buildId,
    (db) =>
      db
        .prepare('SELECT code, class, path, message FROM build_warnings ORDER BY class, path, code')
        .all() as Array<{ code: string; class: string; path: string | null; message: string }>,
  );

  const byClass = new Map<string, typeof warnings>();
  for (const warning of warnings) {
    byClass.set(warning.class, [...(byClass.get(warning.class) ?? []), warning]);
  }

  const lines: string[] = [];
  if (warnings.length === 0) {
    lines.push('No warnings. Everything discovered was indexed.');
  } else {
    lines.push(`${warnings.length} warnings in ${buildId.slice(0, 17)}`, '');
    // Sorted by class name explicitly: the default comparator stringifies each pair, and
    // node:sqlite hands back null-prototype rows that have no `toString` to call.
    for (const [className, group] of [...byClass].sort(([a], [b]) => (a < b ? -1 : 1))) {
      lines.push(`${className} (${group.length})`);
      for (const warning of group) {
        lines.push(`  ${warning.path ?? '.'}: ${warning.message}`);
      }
      lines.push('');
    }
  }

  return {
    human: lines.join('\n').trimEnd(),
    json: {
      buildId,
      total: warnings.length,
      byClass: Object.fromEntries([...byClass].map(([name, group]) => [name, group.length])),
      warnings,
    },
  };
}

function inspectBuild(
  loreDirectory: string,
  buildId: BuildId,
  activeBuildId: BuildId | null,
): CommandResult {
  const manifestPath = join(buildDirectory(loreDirectory, buildId), 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `Build ${buildId} has no manifest.`, {
      remediation: 'Run `lore builds` to see which builds are complete.',
      subject: buildId,
    });
  }
  const manifest = buildManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

  const lines = [
    `Build ${manifest.buildId}${manifest.buildId === activeBuildId ? ' (active)' : ''}`,
    '',
    `  project        ${manifest.projectName}`,
    `  compiler       ${manifest.compilerVersion}`,
    `  schema         ${manifest.schemaVersion}`,
    `  format         ${manifest.formatVersion}`,
    `  capabilities   ${manifest.capabilities.join(', ')}`,
    '',
    `  artifacts      ${manifest.counts.artifacts}`,
    `  nodes          ${manifest.counts.nodes}`,
    `  chunks         ${manifest.counts.chunks}`,
    `  tables         ${manifest.counts.tables}`,
    `  warnings       ${manifest.warnings.length}`,
    '',
    '  canonical roots',
  ];
  for (const [name, hash] of Object.entries(manifest.canonicalRoots)) {
    lines.push(`    ${name.padEnd(10)} ${hash}`);
  }
  lines.push('', `  configuration  ${manifest.configurationHash}`);
  lines.push(`  sources        ${manifest.sourceFingerprint}`);

  return { human: lines.join('\n'), json: manifest };
}

function inspectSources(loreDirectory: string, buildId: BuildId): CommandResult {
  const artifacts = withDatabase(
    loreDirectory,
    buildId,
    (db) =>
      db
        .prepare(
          `SELECT a.display_path AS displayPath, a.media_type AS mediaType, a.status AS status,
                a.authority AS authority, a.parser_id AS parserId, a.byte_size AS byteSize,
                (SELECT count(*) FROM chunks c WHERE c.artifact_id = a.id) AS chunks
           FROM artifacts a ORDER BY a.relative_path`,
        )
        .all() as Array<Record<string, string | number>>,
  );

  const lines = [`${artifacts.length} artifacts in ${buildId.slice(0, 17)}`, ''];
  for (const artifact of artifacts) {
    lines.push(
      `  ${String(artifact.displayPath)}  ${artifact.chunks} chunks, ${artifact.parserId}, ` +
        `${artifact.status}, authority ${artifact.authority}`,
    );
  }

  return { human: lines.join('\n'), json: { buildId, artifacts } };
}

function inspectArtifact(loreDirectory: string, buildId: BuildId, path: string): CommandResult {
  return withDatabase(loreDirectory, buildId, (db) => {
    const artifact = findArtifact(db, path);
    const nodes = db
      .prepare(
        `SELECT id, kind, title, heading_path AS headingPath, line_start AS lineStart
           FROM nodes WHERE artifact_id = ? ORDER BY ordinal`,
      )
      .all(artifact.id) as Array<Record<string, string | number | null>>;
    const chunks = db
      .prepare('SELECT count(*) AS n FROM chunks WHERE artifact_id = ?')
      .get(artifact.id) as { n: number };

    const lines = [
      artifact.display_path,
      '',
      `  artifact       ${artifact.id}`,
      `  media type     ${artifact.media_type}`,
      `  parser         ${artifact.parser_id} ${artifact.parser_version}`,
      `  status         ${artifact.status}`,
      `  authority      ${artifact.authority}`,
      `  bytes          ${artifact.byte_size}`,
      `  content hash   ${artifact.content_hash}`,
      `  chunks         ${chunks.n}`,
      '',
      `  structure (${nodes.length} nodes)`,
    ];
    for (const node of nodes) {
      const depth = (JSON.parse(String(node.headingPath ?? '[]')) as string[]).length;
      const where = node.lineStart === null ? '' : `  line ${node.lineStart}`;
      lines.push(`    ${'  '.repeat(depth)}${node.kind}  ${node.title ?? ''}${where}`.trimEnd());
    }

    return {
      human: lines.join('\n'),
      json: { buildId, artifact, chunkCount: chunks.n, nodes },
    };
  });
}

function inspectChunks(loreDirectory: string, buildId: BuildId, path: string): CommandResult {
  return withDatabase(loreDirectory, buildId, (db) => {
    const artifact = findArtifact(db, path);
    const chunks = db
      .prepare(
        `SELECT id, heading_path AS headingPath, estimated_tokens AS estimatedTokens,
                relative_path AS relativePath, line_start AS lineStart, line_end AS lineEnd
           FROM chunks WHERE artifact_id = ? ORDER BY id`,
      )
      .all(artifact.id) as Array<Record<string, string | number | null>>;

    const lines = [`${chunks.length} chunks in ${artifact.display_path}`, ''];
    for (const chunk of chunks) {
      const heading = (JSON.parse(String(chunk.headingPath ?? '[]')) as string[]).join(' > ');
      const span =
        chunk.lineStart === null
          ? String(chunk.relativePath)
          : `${chunk.relativePath}:${chunk.lineStart}-${chunk.lineEnd}`;
      lines.push(`  ${span}  about ${chunk.estimatedTokens} tokens`);
      if (heading !== '') lines.push(`    ${heading}`);
    }

    return { human: lines.join('\n'), json: { buildId, artifactId: artifact.id, chunks } };
  });
}

/**
 * Finds an artifact by display path, relative path or id, and suggests near misses when
 * nothing matches. A typo in a path is the most likely way to reach this, so the error is
 * only useful if it helps with the next attempt.
 */
interface ArtifactRow extends Record<string, string | number> {
  id: string;
  display_path: string;
}

function findArtifact(db: import('node:sqlite').DatabaseSync, path: string): ArtifactRow {
  const row = db
    .prepare(
      'SELECT * FROM artifacts WHERE display_path = ? OR relative_path = ? OR id = ? LIMIT 1',
    )
    .get(path, path, path) as ArtifactRow | undefined;
  if (row !== undefined) return row;

  const all = (
    db.prepare('SELECT display_path FROM artifacts ORDER BY display_path').all() as Array<{
      display_path: string;
    }>
  ).map((entry) => entry.display_path);
  const needle = path.toLowerCase();
  const close = all.filter((candidate) => candidate.toLowerCase().includes(needle)).slice(0, 5);

  throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No artifact matches ${path}.`, {
    remediation:
      close.length > 0
        ? `Did you mean:\n${close.map((candidate) => `  ${candidate}`).join('\n')}`
        : 'Run `lore inspect sources` to list what this build contains.',
    subject: path,
  });
}
