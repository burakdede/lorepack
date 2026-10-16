import type { DatabaseSync } from 'node:sqlite';
import {
  type Artifact,
  bm25ColumnWeights,
  escapeFtsQuery,
  type LoreNode,
  NATIVE_UNIT_LIMITS,
  type ParsedTable,
  type CatalogSearchHit as RuntimeCatalogSearchHit,
  type SourceLocator,
} from '@lorepack/core';
import { inTransaction } from '../sqlite.js';
import { TABLE_CATALOG_TABLES, writeTables } from './tables.js';

/**
 * Writes a sealed build's catalog.
 *
 * Everything happens in one transaction: a build database is either complete or it is
 * discarded, never partially populated. Inserts are batched through prepared statements
 * because the envelope is 50,000 chunks and preparing per row would dominate the build.
 */

export interface CatalogChunk {
  readonly id: string;
  readonly artifactId: string;
  readonly nodeIds: readonly string[];
  readonly headingPath: readonly string[];
  readonly text: string;
  readonly estimatedTokens: number;
  // Reuses the canonical locator rather than redeclaring its shape, so the two cannot
  // drift and a chunk from the compiler is accepted without a cast.
  readonly locator: SourceLocator;
  readonly revisionHash: string;
}

export interface CatalogArtifact {
  readonly artifact: Artifact;
  readonly nodes: readonly LoreNode[];
  readonly chunks: readonly CatalogChunk[];
  readonly objectHash: string;
  /** Typed tables this artifact produced. Absent for a format that has none. */
  readonly tables?: readonly ParsedTable[];
}

export interface CatalogWarning {
  readonly code: string;
  readonly class: string;
  readonly path?: string;
  readonly message: string;
}

export interface WriteCatalogOptions {
  readonly db: DatabaseSync;
  readonly artifacts: readonly CatalogArtifact[];
  readonly warnings?: readonly CatalogWarning[];
}

export interface CatalogCounts {
  readonly artifacts: number;
  readonly nodes: number;
  readonly chunks: number;
  readonly tables: number;
  readonly tableRows: number;
}

export function writeCatalog(options: WriteCatalogOptions): CatalogCounts {
  const { db, artifacts } = options;

  const insertArtifact = db.prepare(
    `INSERT INTO artifacts
       (id, source_id, relative_path, display_path, media_type, byte_size, content_hash,
        parser_id, parser_version, title, status, authority, object_hash, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertNode = db.prepare(
    `INSERT INTO nodes
       (id, artifact_id, parent_id, kind, ordinal, title, text, heading_path,
        line_start, line_end, metadata, revision_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks
       (id, artifact_id, node_ids, heading_path, text, estimated_tokens, relative_path,
        line_start, line_end, page, revision_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO chunks_fts (chunk_id, artifact_id, status, authority, path, title, heading, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSupersession = db.prepare(
    'INSERT OR IGNORE INTO supersessions (artifact_id, superseded_id) VALUES (?, ?)',
  );
  const insertWarning = db.prepare(
    'INSERT INTO build_warnings (code, class, path, message) VALUES (?, ?, ?, ?)',
  );

  let nodeCount = 0;
  let chunkCount = 0;
  let tableCount = 0;
  let tableRowCount = 0;

  inTransaction(db, () => {
    for (const entry of artifacts) {
      const { artifact } = entry;
      insertArtifact.run(
        artifact.id,
        artifact.sourceId,
        artifact.relativePath,
        artifact.displayPath,
        artifact.mediaType,
        artifact.byteSize,
        artifact.contentHash,
        artifact.parserId,
        artifact.parserVersion,
        artifact.title ?? null,
        artifact.status,
        artifact.authority,
        entry.objectHash,
        JSON.stringify(artifact.metadata),
      );

      for (const superseded of artifact.supersedes) {
        insertSupersession.run(artifact.id, superseded);
      }

      for (const node of entry.nodes) {
        insertNode.run(
          node.id,
          node.artifactId,
          node.parentId ?? null,
          node.kind,
          node.ordinal,
          node.title ?? null,
          node.text ?? null,
          JSON.stringify(node.locator.headingPath ?? []),
          node.locator.lineStart ?? null,
          node.locator.lineEnd ?? null,
          JSON.stringify(node.metadata),
          node.revisionHash,
        );
        nodeCount += 1;
      }

      for (const chunk of entry.chunks) {
        insertChunk.run(
          chunk.id,
          chunk.artifactId,
          JSON.stringify(chunk.nodeIds),
          JSON.stringify(chunk.headingPath),
          chunk.text,
          chunk.estimatedTokens,
          chunk.locator.relativePath,
          chunk.locator.lineStart ?? null,
          chunk.locator.lineEnd ?? null,
          chunk.locator.page ?? null,
          chunk.revisionHash,
        );

        // Path, title and heading are separate columns so the runtime can weight an exact
        // path or heading match above a body match without a second query.
        insertFts.run(
          chunk.id,
          chunk.artifactId,
          artifact.status,
          String(artifact.authority),
          chunk.locator.relativePath,
          artifact.title ?? '',
          chunk.headingPath.join(' '),
          chunk.text,
        );
        chunkCount += 1;
      }
    }

    // Inside the same transaction as everything above, which is what makes a mid-import
    // failure roll back the whole build rather than leave one half-filled table behind.
    const written = writeTables(
      db,
      artifacts.flatMap((entry) => entry.tables ?? []),
    );
    tableCount = written.tables;
    tableRowCount = written.rows;

    for (const warning of options.warnings ?? []) {
      insertWarning.run(warning.code, warning.class, warning.path ?? null, warning.message);
    }
  });

  return {
    artifacts: artifacts.length,
    nodes: nodeCount,
    chunks: chunkCount,
    tables: tableCount,
    tableRows: tableRowCount,
  };
}

export interface CatalogSearchHit {
  readonly nativeUnit?: NonNullable<RuntimeCatalogSearchHit['nativeUnit']>;
  readonly tableReferences?: NonNullable<RuntimeCatalogSearchHit['tableReferences']>;
  readonly chunkId: string;
  readonly artifactId: string;
  readonly relativePath: string;
  readonly displayPath: string;
  readonly headingPath: readonly string[];
  readonly text: string;
  /** The match in context, with the matched terms bracketed by FTS5 itself. */
  readonly excerpt: string;
  /** The page, for a format whose only coordinate is a page. Null for one with lines. */
  readonly page: number | null;
  readonly sheet: string | null;
  readonly cellRange: string | null;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly status: string;
  readonly authority: number;
  readonly estimatedTokens: number;
  readonly title: string | null;
  readonly bm25: number;
}

export interface CatalogSearchOptions {
  readonly nativeUnits?: boolean;
  readonly limit?: number;
  /** Artifact statuses to include. Omitted means every status the build holds. */
  readonly statuses?: readonly string[];
  /** `all` requires every term in one chunk, `any` requires one. Defaults to `all`. */
  readonly match?: 'all' | 'any';
  /** Restricts to one artifact, by id or by canonical path. */
  readonly artifactId?: string;
  /**
   * SQLite GLOB pattern over the relative path (`*` and `?`). GLOB rather than a full
   * glob library because it is parameterized SQL: a filter can never become an injection,
   * and there is no dependency to keep current.
   */
  readonly pathGlob?: string;
  /** File extension without the dot. */
  readonly extension?: string;
}

/** The tables a search connection may read. Includes the FTS5 shadow tables, which the
 *  MATCH implementation reads directly. */
export const SEARCH_TABLES: readonly string[] = [
  'chunks',
  'artifacts',
  'chunks_fts',
  'chunks_fts_data',
  'chunks_fts_idx',
  'chunks_fts_content',
  'chunks_fts_docsize',
  'chunks_fts_config',
];

/**
 * Everything the runtime may read from a sealed build.
 *
 * Wider than `SEARCH_TABLES` because `describeBuild` counts warnings and `readSource`
 * resolves through node records, and narrower than the whole schema on purpose: this is
 * the allowlist a read-only connection is held to, so a capability that starts reading
 * something new has to say so here, in a diff, rather than by accident.
 */
export const RUNTIME_TABLES: readonly string[] = [
  ...SEARCH_TABLES,
  'json_each',
  'nodes',
  'supersessions',
  'build_warnings',
  ...TABLE_CATALOG_TABLES,
];

/**
 * Raw lexical candidates. The ranking pipeline in Phase 2 layers boosts on top; this is
 * deliberately just BM25 plus the columns needed to apply them.
 */
export function searchCatalog(
  db: DatabaseSync,
  query: string,
  options: number | CatalogSearchOptions = {},
): CatalogSearchHit[] {
  const settings: CatalogSearchOptions = typeof options === 'number' ? { limit: options } : options;
  const limit = settings.limit ?? 10;
  const match = escapeFtsQuery(query, settings.match ?? 'all');
  if (match === '') return [];

  const conditions: string[] = ['chunks_fts MATCH ?'];
  const parameters: (string | number)[] = [match];
  if (settings.pathGlob !== undefined) {
    conditions.push('c.relative_path GLOB ?');
    parameters.push(settings.pathGlob);
  }
  if (settings.extension !== undefined) {
    conditions.push('c.relative_path LIKE ?');
    parameters.push(`%.${settings.extension.replace(/^\./, '')}`);
  }
  if (settings.artifactId !== undefined) {
    // Matched against both, because a caller holds whichever the last result gave it.
    conditions.push('(c.artifact_id = ? OR c.relative_path = ?)');
    parameters.push(settings.artifactId, settings.artifactId);
  }
  if (settings.statuses !== undefined && settings.statuses.length > 0) {
    // One placeholder per value, so a status filter stays parameterized SQL rather than
    // becoming string concatenation the moment someone adds a status.
    conditions.push(`a.status IN (${settings.statuses.map(() => '?').join(', ')})`);
    parameters.push(...settings.statuses);
  }
  parameters.push(limit);

  // CROSS JOIN keeps node references in the outer loop even without planner statistics.
  const rows = db
    .prepare(
      `SELECT c.id            AS chunkId,
              c.artifact_id   AS artifactId,
              c.relative_path AS relativePath,
              a.display_path  AS displayPath,
              c.heading_path  AS headingPath,
              c.text          AS text,
              ${
                settings.nativeUnits === true
                  ? `c.node_ids AS unitNodeIds,
              (SELECT json_group_array(json_object(
                'tableId', table_ref.id, 'name', table_ref.name,
                'locator', json_patch(json_object('artifactId', table_ref.artifact_id,
                  'relativePath', table_ref.relative_path), json_object(
                  'sheet', table_ref.sheet, 'cellRange', table_ref.cell_range,
                  'lineStart', table_ref.line_start, 'lineEnd', table_ref.line_end))))
                FROM (SELECT table_ref.id, table_ref.name, table_ref.artifact_id,
                  table_ref.relative_path, table_ref.sheet, table_ref.cell_range,
                  table_ref.line_start, table_ref.line_end FROM tables table_ref
                  WHERE table_ref.artifact_id=c.artifact_id
                  AND table_ref.id IN (
                    SELECT json_extract(unit_node.metadata, '$.tableId')
                    FROM json_each(c.node_ids) ref JOIN nodes unit_node
                      ON unit_node.id=ref.value AND unit_node.artifact_id=c.artifact_id
                      ) ORDER BY table_ref.id) table_ref) AS unitTables,
              CASE WHEN json_array_length(c.node_ids) > 0
                AND (SELECT count(*) FROM json_each(c.node_ids) ref CROSS JOIN nodes unit_node
                  ON unit_node.id=ref.value AND unit_node.artifact_id=c.artifact_id
                  WHERE unit_node.text IS NOT NULL) = json_array_length(c.node_ids)
                AND (SELECT coalesce(sum(length(CAST(unit_node.text AS BLOB))), 0) + max(json_array_length(c.node_ids) - 1, 0) * 2
                  FROM json_each(c.node_ids) ref CROSS JOIN nodes unit_node
                  ON unit_node.id=ref.value AND unit_node.artifact_id=c.artifact_id) <= ${NATIVE_UNIT_LIMITS.maxUtf8Bytes}
              THEN (SELECT group_concat(body, char(10) || char(10)) FROM (
                SELECT unit_node.text AS body FROM json_each(c.node_ids) ref CROSS JOIN nodes unit_node
                ON unit_node.id=ref.value AND unit_node.artifact_id=c.artifact_id
                ORDER BY CAST(ref.key AS INTEGER))) ELSE NULL END AS unitText,
              `
                  : ''
              }c.line_start    AS lineStart,
              c.line_end      AS lineEnd,
              c.page          AS page,
              json_extract(n.metadata, '$.sheet') AS sheet,
              json_extract(n.metadata, '$.cellRange') AS cellRange,
              a.status        AS status,
              a.authority     AS authority,
              c.estimated_tokens AS estimatedTokens,
              a.title         AS title,
              snippet(chunks_fts, 7, '[', ']', ' ... ', 20) AS excerpt,
              bm25(chunks_fts, ${bm25ColumnWeights().join(', ')}) AS bm25
         FROM chunks_fts
         JOIN chunks    c ON c.id = chunks_fts.chunk_id
         JOIN artifacts a ON a.id = c.artifact_id
         LEFT JOIN nodes n ON n.id = json_extract(c.node_ids, '$[0]')
        WHERE ${conditions.join(' AND ')}
        ORDER BY bm25
        LIMIT ?`,
    )
    .all(...parameters) as Array<Record<string, string | number | null>>;

  return rows.map((row) => ({
    chunkId: String(row.chunkId),
    artifactId: String(row.artifactId),
    relativePath: String(row.relativePath),
    displayPath: String(row.displayPath),
    headingPath: JSON.parse(String(row.headingPath)) as string[],
    text: String(row.text),
    ...(settings.nativeUnits === true
      ? {
          tableReferences: JSON.parse(String(row.unitTables)) as NonNullable<
            RuntimeCatalogSearchHit['tableReferences']
          >,
          nativeUnit: {
            nodeIds: JSON.parse(String(row.unitNodeIds)) as string[],
            text: row.unitText === null ? null : String(row.unitText),
          },
        }
      : {}),
    excerpt: String(row.excerpt),
    page: row.page === null || row.page === undefined ? null : Number(row.page),
    sheet: row.sheet === null || row.sheet === undefined ? null : String(row.sheet),
    cellRange: row.cellRange === null || row.cellRange === undefined ? null : String(row.cellRange),
    lineStart: row.lineStart === null ? null : Number(row.lineStart),
    lineEnd: row.lineEnd === null ? null : Number(row.lineEnd),
    status: String(row.status),
    authority: Number(row.authority),
    estimatedTokens: Number(row.estimatedTokens),
    title: row.title === null ? null : String(row.title),
    bm25: Number(row.bm25),
  }));
}

export function countRows(db: DatabaseSync, table: string): number {
  // The table name is never user input: callers pass a literal from this module.
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}
