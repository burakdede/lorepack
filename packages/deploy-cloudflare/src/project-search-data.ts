import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LoreError } from '@lorepack/core';
import type { ProjectionMigrationDatabaseLike } from './projection-migrations.js';

interface BuildNodeRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly parent_id: string | null;
  readonly kind: string;
  readonly ordinal: number;
  readonly title: string | null;
  readonly text: string | null;
  readonly heading_path: string;
  readonly line_start: number | null;
  readonly line_end: number | null;
  readonly metadata: string;
  readonly revision_hash: string;
}

interface BuildChunkRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly node_ids: string;
  readonly heading_path: string;
  readonly text: string;
  readonly estimated_tokens: number;
  readonly relative_path: string;
  readonly line_start: number | null;
  readonly line_end: number | null;
  readonly page: number | null;
  readonly revision_hash: string;
  readonly status: string;
  readonly authority: number;
  readonly title: string | null;
}

export interface ProjectSearchDataOptions {
  readonly db: ProjectionMigrationDatabaseLike;
  readonly projectId: string;
  readonly buildId: string;
  readonly buildDirectory: string;
}

export interface ProjectSearchDataResult {
  readonly projectedNodes: number;
  readonly projectedChunks: number;
  readonly projectedFtsRows: number;
}

const BUILD_NODES_QUERY = `SELECT id, artifact_id, parent_id, kind, ordinal, title, text,
       heading_path, line_start, line_end, metadata, revision_hash
FROM nodes
ORDER BY artifact_id, ordinal, id`;

const BUILD_CHUNKS_QUERY = `SELECT c.id, c.artifact_id, c.node_ids, c.heading_path, c.text,
       c.estimated_tokens, c.relative_path, c.line_start, c.line_end, c.page, c.revision_hash,
       a.status, a.authority, a.title
FROM chunks c
JOIN artifacts a ON a.id = c.artifact_id
ORDER BY c.artifact_id, c.id`;

const DELETE_NODES = 'DELETE FROM nodes WHERE project_id = ? AND build_id = ?';
const DELETE_CHUNKS = 'DELETE FROM chunks WHERE project_id = ? AND build_id = ?';
const DELETE_FTS = 'DELETE FROM chunks_fts WHERE project_id = ? AND build_id = ?';

const INSERT_NODE = `INSERT INTO nodes
  (id, project_id, build_id, artifact_id, parent_id, kind, ordinal, title, text,
   heading_path, line_start, line_end, metadata_json, revision_hash)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_CHUNK = `INSERT INTO chunks
  (id, project_id, build_id, artifact_id, node_ids, heading_path, text, estimated_tokens,
   relative_path, line_start, line_end, page, revision_hash)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_FTS = `INSERT INTO chunks_fts
  (project_id, build_id, chunk_id, artifact_id, status, authority, path, title, heading, body)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export async function projectSearchData(
  options: ProjectSearchDataOptions,
): Promise<ProjectSearchDataResult> {
  const buildDatabase = openBuildDatabase(options.buildDirectory);

  try {
    const nodes = buildDatabase.prepare(BUILD_NODES_QUERY).all() as unknown as BuildNodeRow[];
    const chunks = buildDatabase.prepare(BUILD_CHUNKS_QUERY).all() as unknown as BuildChunkRow[];

    await options.db.prepare('BEGIN IMMEDIATE').run();
    try {
      for (const statement of [DELETE_FTS, DELETE_CHUNKS, DELETE_NODES]) {
        await options.db.prepare(statement).bind(options.projectId, options.buildId).run();
      }

      for (const node of nodes) {
        await options.db
          .prepare(INSERT_NODE)
          .bind(
            node.id,
            options.projectId,
            options.buildId,
            node.artifact_id,
            node.parent_id,
            node.kind,
            node.ordinal,
            node.title,
            node.text,
            node.heading_path,
            node.line_start,
            node.line_end,
            node.metadata,
            node.revision_hash,
          )
          .run();
      }

      for (const chunk of chunks) {
        await options.db
          .prepare(INSERT_CHUNK)
          .bind(
            chunk.id,
            options.projectId,
            options.buildId,
            chunk.artifact_id,
            chunk.node_ids,
            chunk.heading_path,
            chunk.text,
            chunk.estimated_tokens,
            chunk.relative_path,
            chunk.line_start,
            chunk.line_end,
            chunk.page,
            chunk.revision_hash,
          )
          .run();

        const heading = (JSON.parse(chunk.heading_path) as string[]).join(' ');
        await options.db
          .prepare(INSERT_FTS)
          .bind(
            options.projectId,
            options.buildId,
            chunk.id,
            chunk.artifact_id,
            chunk.status,
            String(chunk.authority),
            chunk.relative_path,
            chunk.title ?? '',
            heading,
            chunk.text,
          )
          .run();
      }

      await options.db.prepare('COMMIT').run();
    } catch (cause) {
      await options.db.prepare('ROLLBACK').run();
      throw cause;
    }

    return {
      projectedNodes: nodes.length,
      projectedChunks: chunks.length,
      projectedFtsRows: chunks.length,
    };
  } finally {
    buildDatabase.close();
  }
}

function openBuildDatabase(buildDirectory: string): DatabaseSync {
  const path = join(buildDirectory, 'context.sqlite');
  if (!existsSync(path)) {
    throw new LoreError(
      'LORE_E_BUILD_NOT_FOUND',
      `Build ${buildDirectory} has no context.sqlite.`,
      {
        remediation: 'Project only a verified sealed build directory.',
        subject: path,
      },
    );
  }

  try {
    return new DatabaseSync(path, {
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
  } catch (cause) {
    throw new LoreError('LORE_E_SQLITE_UNAVAILABLE', `Cannot open ${path} for reading.`, {
      remediation: 'Check that the sealed build exists and is readable.',
      cause,
    });
  }
}
