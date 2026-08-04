import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openReadOnly } from '@lorepack/backend-local';
import {
  type BuildId,
  type BuildManifest,
  buildManifestSchema,
  count,
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

const SUBJECTS = [
  'warnings',
  'exclusions',
  'sources',
  'build',
  'chunks',
  'tables',
  'builds',
] as const;
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
          case 'exclusions':
            return inspectExclusions(loreDirectory, buildId);
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
          case 'tables':
            return inspectTables(loreDirectory, buildId, args[1] ?? '');
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
    lines.push(`${count(warnings.length, 'warning')} in ${buildId.slice(0, 17)}`, '');
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

/** The sealed manifest, validated. One reader, so two subjects cannot disagree about it. */
function readManifest(loreDirectory: string, buildId: BuildId): BuildManifest {
  const manifestPath = join(buildDirectory(loreDirectory, buildId), 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `Build ${buildId} has no manifest.`, {
      remediation: 'Run `lore builds` to see which builds are complete.',
      subject: buildId,
    });
  }
  return buildManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
}

/**
 * What ignore rules removed, read from the sealed manifest.
 *
 * The other half of "exactly what was not parsed". `lore inspect warnings` lists files the
 * walk read and could not use; this lists the ones a rule removed before anything was read,
 * which is the more common reason a document is missing and was recorded nowhere until #202.
 *
 * Grouped by rule, because one line of configuration is one decision however many files it
 * covers, and a per-file listing of an excluded dependency tree would be longer than the
 * project.
 */
function inspectExclusions(loreDirectory: string, buildId: BuildId): CommandResult {
  const manifest = readManifest(loreDirectory, buildId);
  const exclusions = manifest.exclusions;

  if (exclusions === undefined) {
    return {
      human: [
        `${buildId.slice(0, 17)} does not record what its ignore rules removed.`,
        '',
        'It was built before that record existed. Run `lore build` to make one that does.',
      ].join('\n'),
      json: { buildId, recorded: false, total: 0, exclusions: [] },
    };
  }

  const total = exclusions.reduce((sum, exclusion) => sum + exclusion.count, 0);
  const lines: string[] = [];
  if (exclusions.length === 0) {
    lines.push('No ignore rule removed anything. Every file in scope reached the build.');
  } else {
    lines.push(
      `${count(total, 'path')} removed by ${count(exclusions.length, 'rule')} in ${buildId.slice(0, 17)}`,
      '',
    );
    for (const exclusion of exclusions) {
      lines.push(
        `${exclusion.pattern}  ${count(exclusion.count, 'path')}, from ${exclusion.source}`,
      );
      for (const path of exclusion.sample) lines.push(`  ${path}`);
      const remaining = exclusion.count - exclusion.sample.length;
      if (remaining > 0) lines.push(`  and ${count(remaining, 'more path')}`);
      lines.push('');
    }
  }

  return {
    human: lines.join('\n').trimEnd(),
    json: { buildId, recorded: true, total, exclusions },
  };
}

function inspectBuild(
  loreDirectory: string,
  buildId: BuildId,
  activeBuildId: BuildId | null,
): CommandResult {
  const manifest = readManifest(loreDirectory, buildId);

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

  const lines = [`${count(artifacts.length, 'artifact')} in ${buildId.slice(0, 17)}`, ''];
  for (const artifact of artifacts) {
    lines.push(
      `  ${String(artifact.displayPath)}  ${count(Number(artifact.chunks), 'chunk')}, ${artifact.parserId}, ` +
        `${artifact.status}, authority ${artifact.authority}`,
    );
  }

  return { human: lines.join('\n'), json: { buildId, artifacts } };
}

function inspectArtifact(loreDirectory: string, buildId: BuildId, path: string): CommandResult {
  return withDatabase(loreDirectory, buildId, (db) => {
    const artifact = findArtifact(db, path);
    // Ordered by the ordinal path in the node id, not by `ordinal`.
    //
    // `ordinal` is a node's position among its siblings, which is exactly what it says it
    // is and exactly what node ids need. It is not a document position, so ordering by it
    // across different parents sorted a document's paragraphs ahead of the sections they
    // belong to and left ties for SQLite to break (#149). The id carries the whole path,
    // `demo:a.md#0.1.2.1`, so it orders and nests the tree by itself.
    const nodes = orderByTree(
      db
        .prepare(
          `SELECT id, kind, title, heading_path AS headingPath, line_start AS lineStart
             FROM nodes WHERE artifact_id = ?`,
        )
        .all(artifact.id) as Array<Record<string, string | number | null>>,
    );
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
      `  structure (${count(nodes.length, 'node')})`,
    ];
    for (const node of nodes) {
      // Depth from the tree, not from how many headings are above the node. A paragraph
      // inside "Access" has two entries in its heading path while the "Access" section
      // itself has one, so heading depth rendered a leaf deeper than its own parent.
      const depth = Math.max(0, ordinalPath(String(node.id)).length - 1);
      const where = node.lineStart === null ? '' : `  line ${node.lineStart}`;
      lines.push(`    ${'  '.repeat(depth)}${node.kind}  ${node.title ?? ''}${where}`.trimEnd());
    }

    return {
      human: lines.join('\n'),
      json: { buildId, artifact, chunkCount: chunks.n, nodes },
    };
  });
}

/**
 * The ordinal path a node id ends with, as numbers.
 *
 * `demo:docs/a.md#0.1.2` is `[0, 1, 2]`. Numbers rather than the string, because a
 * lexicographic sort puts the tenth sibling before the second.
 */
export function ordinalPath(id: string): number[] {
  const suffix = id.slice(id.lastIndexOf('#') + 1);
  if (suffix === '' || suffix === id) return [];
  return suffix.split('.').map((segment) => {
    const value = Number(segment);
    return Number.isFinite(value) ? value : 0;
  });
}

/** A row from the `nodes` table, as `node:sqlite` hands it back. */
type NodeRow = Record<string, string | number | null>;

/** Document order: every node after its parent, siblings in the order they were written. */
export function orderByTree(nodes: readonly NodeRow[]): NodeRow[] {
  return [...nodes].sort((left, right) => {
    const a = ordinalPath(String(left.id));
    const b = ordinalPath(String(right.id));
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const difference = (a[index] ?? -1) - (b[index] ?? -1);
      if (difference !== 0) return difference;
    }
    return 0;
  });
}

/**
 * How many chunks the bare subject lists before it stops.
 *
 * A whole build is tens of thousands of chunks, which is a scroll rather than an answer.
 * The limit is stated in the output: a listing that silently truncates reads as "that is
 * all there is", which is a quieter version of the same defect this command had.
 */
const CHUNK_LISTING_LIMIT = 50;

/**
 * With a path, the chunks of one artifact. Without one, the chunks of the build.
 *
 * The bare form used to look the empty string up as an artifact and fail with "No artifact
 * matches ." and a list of suggestions for a word the user never typed (#166). Every other
 * subject works bare, and the help text has always said this one does too.
 */
function inspectChunks(loreDirectory: string, buildId: BuildId, path: string): CommandResult {
  return withDatabase(loreDirectory, buildId, (db) => {
    const artifact = path === '' ? null : findArtifact(db, path);
    const select = `SELECT id, heading_path AS headingPath, estimated_tokens AS estimatedTokens,
                relative_path AS relativePath, line_start AS lineStart, line_end AS lineEnd
           FROM chunks`;
    const chunks = (
      artifact === null
        ? db.prepare(`${select} ORDER BY relative_path, id`).all()
        : db.prepare(`${select} WHERE artifact_id = ? ORDER BY id`).all(artifact.id)
    ) as Array<Record<string, string | number | null>>;

    const where = artifact === null ? buildId.slice(0, 17) : String(artifact.display_path);
    const shown = artifact === null ? chunks.slice(0, CHUNK_LISTING_LIMIT) : chunks;
    const lines = [`${count(chunks.length, 'chunk')} in ${where}`, ''];
    for (const chunk of shown) {
      const heading = (JSON.parse(String(chunk.headingPath ?? '[]')) as string[]).join(' > ');
      const span =
        chunk.lineStart === null
          ? String(chunk.relativePath)
          : `${chunk.relativePath}:${chunk.lineStart}-${chunk.lineEnd}`;
      lines.push(`  ${span}  about ${count(Number(chunk.estimatedTokens), 'token')}`);
      if (heading !== '') lines.push(`    ${heading}`);
    }
    if (shown.length < chunks.length) {
      lines.push(
        '',
        `Showing the first ${shown.length}. Pass a source path for one artifact's chunks, or use --json for all of them.`,
      );
    }

    return {
      human: lines.join('\n'),
      json: { buildId, artifactId: artifact === null ? null : artifact.id, chunks },
    };
  });
}

/**
 * The typed tables in a build: bare, a listing; with a table id or a path, one schema.
 *
 * This is the only way to see a table's shape until the SQL surface lands, and it is what
 * the runtime's own "no query yet" message points a user at, so it has to exist and has to
 * be worth reading. Columns come out in source order with their inferred types, because the
 * type is the decision a user is most likely to want to argue with.
 */
function inspectTables(loreDirectory: string, buildId: BuildId, target: string): CommandResult {
  return withDatabase(loreDirectory, buildId, (db) => {
    const tables = db
      .prepare(
        `SELECT id, name, sheet, row_count AS rowCount, relative_path AS relativePath, metadata
           FROM tables ORDER BY relative_path, name`,
      )
      .all() as Array<Record<string, string | number | null>>;

    if (target === '') {
      if (tables.length === 0) {
        return {
          human:
            'This build contains no tables.\n\nCSV and spreadsheet files become tables; other formats become text.',
          json: { buildId, tables: [] },
        };
      }
      const lines = [`${count(tables.length, 'table')} in ${buildId.slice(0, 17)}`, ''];
      for (const table of tables) {
        const sheet = table.sheet === null ? '' : ` (sheet ${String(table.sheet)})`;
        lines.push(
          `  ${String(table.name)}${sheet}  ${count(Number(table.rowCount), 'row')}  ${String(table.relativePath)}`,
        );
        lines.push(`    ${String(table.id)}`);
      }
      lines.push('', 'Pass a table id or a source path to see its columns.');
      return { human: lines.join('\n'), json: { buildId, tables } };
    }

    const table = tables.find(
      (one) => one.id === target || one.relativePath === target || one.name === target,
    );
    if (table === undefined) {
      throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No table matches ${target}.`, {
        remediation: 'Run `lore inspect tables` to see the tables this build contains.',
        subject: target,
      });
    }

    const columns = db
      .prepare(
        `SELECT name, type, nullable, null_count AS nullCount,
                distinct_estimate AS distinctEstimate, distinct_is_exact AS distinctIsExact,
                min_value AS minValue, max_value AS maxValue
           FROM table_columns WHERE table_id = ? ORDER BY ordinal`,
      )
      .all(String(table.id)) as Array<Record<string, string | number | null>>;

    const lines = [
      `Table ${String(table.name)} (${String(table.relativePath)})`,
      '',
      `  rows           ${String(table.rowCount)}`,
      `  columns        ${String(columns.length)}`,
      '',
      '  column                          type      nulls   distinct  range',
    ];
    for (const column of columns) {
      const distinct = `${column.distinctIsExact === 1 ? '' : '>='}${String(column.distinctEstimate)}`;
      const range =
        column.minValue === null ? '' : `${String(column.minValue)} .. ${String(column.maxValue)}`;
      lines.push(
        `  ${String(column.name).slice(0, 30).padEnd(30)}  ${String(column.type).padEnd(8)}  ${String(column.nullCount).padEnd(6)}  ${distinct.padEnd(8)}  ${range.slice(0, 40)}`,
      );
    }
    // How the file was read is a judgement the build made, and a column typed unexpectedly
    // is usually explained by it. Printing it here saves reading the manifest.
    const metadata = JSON.parse(String(table.metadata ?? '{}')) as Record<string, unknown>;
    if (Object.keys(metadata).length > 0) {
      lines.push('', '  how it was read');
      for (const [key, value] of Object.entries(metadata).sort()) {
        lines.push(`    ${key.padEnd(20)} ${JSON.stringify(value)}`);
      }
    }

    return { human: lines.join('\n'), json: { buildId, table, columns, metadata } };
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
