import type {
  BuildManifest,
  CatalogArtifact,
  CatalogArtifactSummary,
  CatalogNode,
  CatalogSearchCriteria,
  CatalogSearchHit,
  CatalogStore,
} from '@lorepack/core';

export interface D1CatalogStatementLike {
  bind(...values: unknown[]): D1CatalogStatementLike;
  run<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }>;
}

export interface D1CatalogDatabaseLike {
  prepare(query: string): D1CatalogStatementLike;
}

export interface D1CatalogNamespace {
  readonly projectId: string;
  readonly buildId: string;
}

export interface D1CatalogStoreOptions {
  readonly db: D1CatalogDatabaseLike;
  readonly namespace: D1CatalogNamespace;
  readonly manifest: () => Promise<BuildManifest>;
}

interface ArtifactRow {
  readonly id: string;
  readonly relativePath: string;
  readonly displayPath: string;
  readonly title: string | null;
  readonly status: string;
  readonly authority: number;
  readonly mediaType: string;
  readonly objectHash: string;
  readonly byteSize?: number;
  readonly parserId?: string;
  readonly chunkCount?: number;
  readonly nodeCount?: number;
}

interface NodeRow {
  readonly id: string;
  readonly artifactId: string;
  readonly kind: string;
  readonly ordinal: number;
  readonly title: string | null;
  readonly text: string | null;
  readonly headingPath: string;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
}

interface SearchRow {
  readonly chunkId: string;
  readonly artifactId: string;
  readonly relativePath: string;
  readonly displayPath: string;
  readonly headingPath: string;
  readonly text: string;
  readonly excerpt: string;
  readonly page: number | null;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly status: string;
  readonly authority: number;
  readonly estimatedTokens: number;
  readonly title: string | null;
  readonly bm25: number;
}

const MATCH_ALL = 'all';
const MATCH_ANY = 'any';

const COUNT_CHUNKS_QUERY = `SELECT count(*) AS count
FROM chunks
WHERE project_id = ? AND build_id = ?`;

const COUNT_WARNINGS_QUERY = `SELECT count(*) AS count
FROM build_warnings
WHERE project_id = ? AND build_id = ?`;

const ARTIFACTS_QUERY = `SELECT a.id, a.relative_path AS relativePath, a.display_path AS displayPath, a.title,
       a.status, a.authority, a.media_type AS mediaType, a.object_hash AS objectHash,
       a.byte_size AS byteSize, a.parser_id AS parserId,
       (SELECT count(*) FROM chunks c
         WHERE c.project_id = a.project_id AND c.build_id = a.build_id AND c.artifact_id = a.id) AS chunkCount,
       (SELECT count(*) FROM nodes n
         WHERE n.project_id = a.project_id AND n.build_id = a.build_id AND n.artifact_id = a.id) AS nodeCount
FROM artifacts a
WHERE a.project_id = ? AND a.build_id = ?
ORDER BY a.relative_path`;

const ARTIFACT_QUERY = `SELECT id, relative_path AS relativePath, display_path AS displayPath, title,
       status, authority, media_type AS mediaType, object_hash AS objectHash
FROM artifacts
WHERE project_id = ? AND build_id = ? AND (id = ? OR relative_path = ?)
LIMIT 1`;

const NODES_QUERY = `SELECT id, artifact_id AS artifactId, kind, ordinal, title, text,
       heading_path AS headingPath, line_start AS lineStart, line_end AS lineEnd
FROM nodes
WHERE project_id = ? AND build_id = ? AND artifact_id = ?
ORDER BY ordinal`;

const SUPERSESSIONS_QUERY = `SELECT superseded_id AS supersededId
FROM supersessions
WHERE project_id = ? AND build_id = ?`;

export class D1CatalogStore implements CatalogStore {
  readonly #db: D1CatalogDatabaseLike;
  readonly #namespace: D1CatalogNamespace;
  readonly #manifest: () => Promise<BuildManifest>;

  constructor(options: D1CatalogStoreOptions) {
    this.#db = options.db;
    this.#namespace = options.namespace;
    this.#manifest = options.manifest;
  }

  async manifest(): Promise<BuildManifest> {
    return this.#manifest();
  }

  async countChunks(): Promise<number> {
    return this.#count(COUNT_CHUNKS_QUERY);
  }

  async countWarnings(): Promise<number> {
    return this.#count(COUNT_WARNINGS_QUERY);
  }

  async artifacts(): Promise<readonly CatalogArtifactSummary[]> {
    const rows = await this.#run<ArtifactRow>(ARTIFACTS_QUERY, [
      this.#namespace.projectId,
      this.#namespace.buildId,
    ]);
    return rows.map((row) => ({
      artifactId: row.id,
      relativePath: row.relativePath,
      displayPath: row.displayPath,
      title: row.title,
      status: row.status as CatalogArtifact['status'],
      authority: Number(row.authority),
      mediaType: row.mediaType,
      objectHash: row.objectHash,
      byteSize: Number(row.byteSize ?? 0),
      parserId: String(row.parserId ?? ''),
      chunkCount: Number(row.chunkCount ?? 0),
      nodeCount: Number(row.nodeCount ?? 0),
    }));
  }

  async artifact(idOrPath: string): Promise<CatalogArtifact | null> {
    const row = (
      await this.#run<ArtifactRow>(ARTIFACT_QUERY, [
        this.#namespace.projectId,
        this.#namespace.buildId,
        idOrPath,
        idOrPath,
      ])
    )[0];
    if (row === undefined) return null;
    return {
      artifactId: row.id,
      relativePath: row.relativePath,
      displayPath: row.displayPath,
      title: row.title,
      status: row.status as CatalogArtifact['status'],
      authority: Number(row.authority),
      mediaType: row.mediaType,
      objectHash: row.objectHash,
    };
  }

  async nodes(artifactId: string): Promise<readonly CatalogNode[]> {
    const rows = await this.#run<NodeRow>(NODES_QUERY, [
      this.#namespace.projectId,
      this.#namespace.buildId,
      artifactId,
    ]);
    return rows.map((row) => ({
      nodeId: row.id,
      artifactId: row.artifactId,
      kind: row.kind,
      ordinal: Number(row.ordinal),
      title: row.title,
      text: row.text ?? '',
      headingPath: JSON.parse(row.headingPath) as string[],
      lineStart: row.lineStart === null ? null : Number(row.lineStart),
      lineEnd: row.lineEnd === null ? null : Number(row.lineEnd),
    }));
  }

  async supersededArtifacts(): Promise<ReadonlySet<string>> {
    const rows = await this.#run<{ supersededId: string }>(SUPERSESSIONS_QUERY, [
      this.#namespace.projectId,
      this.#namespace.buildId,
    ]);
    return new Set(rows.map((row) => row.supersededId));
  }

  async search(
    query: string,
    criteria: CatalogSearchCriteria,
  ): Promise<readonly CatalogSearchHit[]> {
    const match = escapeFtsQuery(query, criteria.match ?? MATCH_ALL);
    if (match === '') return [];

    const conditions: string[] = [
      'f.project_id = ?',
      'f.build_id = ?',
      'c.project_id = ?',
      'c.build_id = ?',
      'a.project_id = ?',
      'a.build_id = ?',
      'chunks_fts MATCH ?',
    ];
    const parameters: (string | number)[] = [
      this.#namespace.projectId,
      this.#namespace.buildId,
      this.#namespace.projectId,
      this.#namespace.buildId,
      this.#namespace.projectId,
      this.#namespace.buildId,
      match,
    ];

    if (criteria.pathGlob !== undefined) {
      conditions.push('c.relative_path GLOB ?');
      parameters.push(criteria.pathGlob);
    }
    if (criteria.extension !== undefined) {
      conditions.push('c.relative_path LIKE ?');
      parameters.push(`%.${criteria.extension.replace(/^\./, '')}`);
    }
    if (criteria.artifactId !== undefined) {
      conditions.push('(c.artifact_id = ? OR c.relative_path = ?)');
      parameters.push(criteria.artifactId, criteria.artifactId);
    }
    if (criteria.statuses !== undefined && criteria.statuses.length > 0) {
      conditions.push(`a.status IN (${criteria.statuses.map(() => '?').join(', ')})`);
      parameters.push(...criteria.statuses);
    }
    parameters.push(criteria.limit);

    const rows = await this.#run<SearchRow>(
      `SELECT c.id AS chunkId,
              c.artifact_id AS artifactId,
              c.relative_path AS relativePath,
              a.display_path AS displayPath,
              c.heading_path AS headingPath,
              c.text AS text,
              c.line_start AS lineStart,
              c.line_end AS lineEnd,
              c.page AS page,
              a.status AS status,
              a.authority AS authority,
              c.estimated_tokens AS estimatedTokens,
              a.title AS title,
              snippet(chunks_fts, 9, '[', ']', ' ... ', 20) AS excerpt,
              bm25(chunks_fts, 10.0, 4.0, 6.0, 1.0) AS bm25
         FROM chunks_fts f
         JOIN chunks c
           ON c.id = f.chunk_id AND c.project_id = f.project_id AND c.build_id = f.build_id
         JOIN artifacts a
           ON a.id = c.artifact_id AND a.project_id = c.project_id AND a.build_id = c.build_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY bm25
        LIMIT ?`,
      parameters,
    );

    return rows.map((row) => ({
      chunkId: row.chunkId,
      artifactId: row.artifactId,
      relativePath: row.relativePath,
      displayPath: row.displayPath,
      headingPath: JSON.parse(row.headingPath) as string[],
      text: row.text,
      excerpt: row.excerpt,
      page: row.page === null ? null : Number(row.page),
      lineStart: row.lineStart === null ? null : Number(row.lineStart),
      lineEnd: row.lineEnd === null ? null : Number(row.lineEnd),
      status: row.status as CatalogSearchHit['status'],
      authority: Number(row.authority),
      estimatedTokens: Number(row.estimatedTokens),
      title: row.title,
      bm25: Number(row.bm25),
    }));
  }

  async #count(query: string): Promise<number> {
    const row = (
      await this.#run<{ count: number }>(query, [
        this.#namespace.projectId,
        this.#namespace.buildId,
      ])
    )[0];
    return Number(row?.count ?? 0);
  }

  async #run<T>(query: string, bindings: readonly unknown[]): Promise<readonly T[]> {
    const result = await this.#db
      .prepare(query)
      .bind(...bindings)
      .run<T>();
    return result.results ?? [];
  }
}

function escapeFtsQuery(query: string, match: 'all' | 'any'): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/"/g, '""').trim())
    .filter((term) => term !== '' && term !== '""');
  return terms.map((term) => `"${term}"`).join(match === MATCH_ANY ? ' OR ' : ' ');
}
