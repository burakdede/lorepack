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

export interface SearchResult {
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

export interface ContextBundle {
  buildId: string;
  sourceState: SourceState;
  task: string;
  profile: ContextProfile;
  budget: number;
  estimatedTokens: number;
  reservedTokens: number;
  overview: ContextItem[];
  selected: ContextItem[];
  tables: Array<{ tableId: string; name: string }>;
  alternatives: ContextItem[];
  omitted: OmittedItem[];
  citations: SourceLocator[];
}

export interface BuildDescription {
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

export interface SourceReadResult {
  buildId: string;
  sourceState: SourceState;
  text: string;
  truncated: boolean;
  locator: SourceLocator;
}

export interface TableDescription {
  buildId: string;
  sourceState: SourceState;
  tableId: string;
  name: string;
  sheet?: string | undefined;
  columns: Array<{
    name: string;
    type: 'text' | 'integer' | 'real' | 'boolean' | 'date' | 'unknown';
    nullable: boolean;
  }>;
  rowCount: number;
  sample: Array<Record<string, unknown>>;
  locator: SourceLocator;
}

export interface TableQueryResult {
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
  query: string;
  limit?: number | undefined;
  includeArchived?: boolean | undefined;
  pathGlob?: string | undefined;
  fileType?: string | undefined;
  status?: ArtifactStatus[] | undefined;
  debug?: boolean | undefined;
}

export interface TaskContextRequest {
  task: string;
  profile?: ContextProfile | undefined;
  budget?: number | undefined;
  includeArchived?: boolean | undefined;
  filters?: Array<{ kind: 'path' | 'type' | 'status'; value: string }> | undefined;
}

export interface SourceReadOptions {
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
  headingPath?: string[] | undefined;
}
