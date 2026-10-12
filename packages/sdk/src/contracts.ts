/**
 * The wire contracts, restated.
 *
 * `@lorepack/sdk` depends on nothing, including no workspace package, which is what lets a
 * custom agent install it without pulling a compiler, a database driver or a schema
 * library behind it. The cost is that these types are written here rather than imported
 * from `@lorepack/core`.
 *
 * That cost is paid for by `tools/contract`, which asserts mutual assignability between
 * every type below and the Zod-inferred type it mirrors. A contract change therefore fails
 * to compile in CI rather than surprising a consumer at runtime, which is the guarantee the
 * ticket asks for; the types are simply checked rather than generated.
 */

export interface RuntimeIdentity {
  corpusId: string;
  namespaceId: string;
}

export type SourceState = 'clean' | 'dirty' | 'unknown';
export type ArtifactStatus = 'active' | 'draft' | 'archived';
export type ContextProfile = 'agent' | 'coding' | 'chat' | 'deep';
export type Capability =
  | 'lexical-search'
  | 'structured-context'
  | 'table-query'
  | 'semantic-search';

export interface SourceLocator {
  artifactId: string;
  relativePath: string;
  page?: number | undefined;
  headingPath?: string[] | undefined;
  sheet?: string | undefined;
  cellRange?: string | undefined;
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
}

export interface SearchHit {
  chunkId: string;
  artifactId: string;
  score: number;
  excerpt: string;
  headingPath: string[];
  status: ArtifactStatus;
  labels: Array<'draft' | 'archived' | 'superseded'>;
  locator: SourceLocator;
  scoreComponents?: Record<string, number> | undefined;
}

export interface SearchResult extends RuntimeIdentity {
  buildId: string;
  sourceState: SourceState;
  hits: SearchHit[];
  totalIndexedChunks: number;
}

export interface ContextItem {
  chunkId: string;
  text: string;
  estimatedTokens: number;
  headingPath: string[];
  labels: Array<'draft' | 'archived' | 'superseded'>;
  locator: SourceLocator;
}

export interface OmittedItem {
  chunkId: string;
  reason: 'budget' | 'duplicate' | 'diversity' | 'superseded' | 'archived' | 'filtered';
  estimatedTokens: number;
  locator: SourceLocator;
}

export type ExecutionJson =
  | string
  | number
  | boolean
  | null
  | ExecutionJson[]
  | { [key: string]: ExecutionJson };

export interface ExecutionPolicy {
  version: 1;
  canonicalizationVersion: number;
  retrieval: {
    version: number;
    normalization: 'fts5-unicode61';
    queryVersion: number;
    rankingVersion: number;
    weightsVersion: number;
    weights: ExecutionJson;
  };
  packing: {
    version: number;
    profile: ContextProfile;
    budget: number;
    orientationShare: number;
    maximumItemsPerArtifact: number;
    maximumAlternatives: number;
    unit: 'whole-chunk';
  };
  estimator: { version: number; mode: 'stored-chunk-estimates'; compilerVersion: string };
  visibility: {
    version: number;
    default: 'current-preferred-with-historical-fallback' | 'current-only';
    includeArchived: boolean;
    drafts: 'eligible-labeled-downranked';
  };
  serialization: { version: number; format: 'context-bundle-json' };
}

export interface ExecutionSelection extends RuntimeIdentity {
  buildId: string;
  task: string;
  filters: Array<{ kind: 'path' | 'type' | 'status'; value: string }>;
}

export interface ExecutionIdentity {
  version: 1;
  policyId: string;
  selectionId: string;
  policy: ExecutionPolicy;
  selection: ExecutionSelection;
}

export interface ContextBundle extends RuntimeIdentity {
  execution: ExecutionIdentity;
  buildId: string;
  sourceState: SourceState;
  task: string;
  profile: ContextProfile;
  budget: number;
  candidateLimit: number;
  candidateLimitHit: boolean;
  candidateMatchMode: 'all' | 'any';
  estimatedTokens: number;
  reservedTokens: number;
  overview: ContextItem[];
  selected: ContextItem[];
  tables: Array<{ tableId: string; name: string }>;
  alternatives: ContextItem[];
  omitted: OmittedItem[];
  citations: SourceLocator[];
}

export interface BuildDescription extends RuntimeIdentity {
  buildId: string;
  sourceState: SourceState;
  projectName: string;
  shortBuildId: string;
  capabilities: Capability[];
  counts: {
    artifacts: number;
    nodes: number;
    chunks: number;
    tables: number;
    tableRows: number;
  };
  warningCount: number;
  schemaVersion: number;
  compilerVersion: string;
  createdAt?: string | undefined;
}

export interface SourceReadResult extends RuntimeIdentity {
  buildId: string;
  sourceState: SourceState;
  text: string;
  truncated: boolean;
  locator: SourceLocator;
}

/**
 * What was measured about a column at import.
 *
 * `min` and `max` are typed to the column rather than to their storage: they are held as text
 * in the catalog, because one column cannot hold the numbers, dates and strings that different
 * columns produce, and are parsed back on the way out.
 */
export interface ColumnStatistics {
  nullCount: number;
  distinctEstimate: number;
  /** Exact below a bounded cardinality, a lower bound above it. Never a guess. */
  distinctIsExact: boolean;
  min?: string | number | boolean | undefined;
  max?: string | number | boolean | undefined;
}

export interface TableDescription extends RuntimeIdentity {
  buildId: string;
  sourceState: SourceState;
  tableId: string;
  name: string;
  /**
   * The generated physical table name, which is what a query must address.
   *
   * Source names never reach SQL, so `SELECT * FROM "Orders"` is refused. This is what makes
   * a description sufficient on its own to write a query that runs.
   */
  sqlName: string;
  sheet?: string | undefined;
  columns: Array<{
    name: string;
    /** The generated column name, for the same reason as the table's. */
    sqlName: string;
    type: 'text' | 'integer' | 'real' | 'boolean' | 'date' | 'unknown';
    nullable: boolean;
    statistics: ColumnStatistics;
  }>;
  rowCount: number;
  sample: Array<Record<string, unknown>>;
  locator: SourceLocator;
}

export interface TableQueryResult extends RuntimeIdentity {
  buildId: string;
  sourceState: SourceState;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  locator: SourceLocator;
}

/** What `/health` answers. Deliberately small: a probe should learn nothing else. */
export interface HealthResult {
  status: 'ok' | 'no-build';
  buildId: string | null;
  generation: number | null;
  sourceState: SourceState;
}

/**
 * What a caller sends. Optional fields admit an explicit `undefined` because the server's
 * parsed types do, and `exactOptionalPropertyTypes` makes those two different types.
 */
export interface SearchRequest {
  buildId?: string | undefined;
  query: string;
  limit?: number | undefined;
  includeArchived?: boolean | undefined;
  pathGlob?: string | undefined;
  fileType?: string | undefined;
  /** Narrows to one document, by artifact id or canonical path. */
  artifactId?: string | undefined;
  status?: ArtifactStatus[] | undefined;
  debug?: boolean | undefined;
}

export interface TaskContextRequest {
  buildId?: string | undefined;
  task: string;
  profile?: ContextProfile | undefined;
  budget?: number | undefined;
  /** Permits a budget outside the supported 4,000 to 40,000 range. */
  allowUnsupportedBudget?: boolean | undefined;
  includeArchived?: boolean | undefined;
  filters?: Array<{ kind: 'path' | 'type' | 'status'; value: string }> | undefined;
}

export interface SourceReadOptions {
  buildId?: string | undefined;
  page?: number | undefined;
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
  headingPath?: string[] | undefined;
}
