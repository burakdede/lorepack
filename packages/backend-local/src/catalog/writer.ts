import type { DatabaseSync } from 'node:sqlite';
import type { Artifact, LoreNode, SourceLocator } from '@lorepack/core';

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
        line_start, line_end, revision_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  db.exec('BEGIN IMMEDIATE');
  try {
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

    for (const warning of options.warnings ?? []) {
      insertWarning.run(warning.code, warning.class, warning.path ?? null, warning.message);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    artifacts: artifacts.length,
    nodes: nodeCount,
    chunks: chunkCount,
    tables: 0,
    tableRows: 0,
  };
}

/**
 * Escapes a user query for an FTS5 MATCH expression.
 *
 * Every term is quoted, so `NEAR`, `AND`, `*` and `"` are treated as text rather than as
 * syntax. Users get literal search and can never produce a syntax error; operator support
 * would be a deliberate feature with its own surface, not an accident of quoting.
 */
export function escapeFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/"/g, '""').trim())
    .filter((term) => term !== '' && term !== '""');
  return terms.map((term) => `"${term}"`).join(' ');
}

export interface CatalogSearchHit {
  readonly chunkId: string;
  readonly artifactId: string;
  readonly relativePath: string;
  readonly displayPath: string;
  readonly headingPath: readonly string[];
  readonly text: string;
  /** The match in context, with the matched terms bracketed by FTS5 itself. */
  readonly excerpt: string;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly status: string;
  readonly authority: number;
  readonly bm25: number;
}

export interface CatalogSearchOptions {
  readonly limit?: number;
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
  const match = escapeFtsQuery(query);
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
  parameters.push(limit);

  const rows = db
    .prepare(
      `SELECT c.id            AS chunkId,
              c.artifact_id   AS artifactId,
              c.relative_path AS relativePath,
              a.display_path  AS displayPath,
              c.heading_path  AS headingPath,
              c.text          AS text,
              c.line_start    AS lineStart,
              c.line_end      AS lineEnd,
              a.status        AS status,
              a.authority     AS authority,
              snippet(chunks_fts, 7, '[', ']', ' ... ', 20) AS excerpt,
              bm25(chunks_fts, 0.0, 0.0, 0.0, 0.0, 4.0, 6.0, 3.0, 1.0) AS bm25
         FROM chunks_fts
         JOIN chunks    c ON c.id = chunks_fts.chunk_id
         JOIN artifacts a ON a.id = c.artifact_id
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
    excerpt: String(row.excerpt),
    lineStart: row.lineStart === null ? null : Number(row.lineStart),
    lineEnd: row.lineEnd === null ? null : Number(row.lineEnd),
    status: String(row.status),
    authority: Number(row.authority),
    bm25: Number(row.bm25),
  }));
}

export function countRows(db: DatabaseSync, table: string): number {
  // The table name is never user input: callers pass a literal from this module.
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}
