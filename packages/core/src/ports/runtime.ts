import type { BuildManifest } from '../schemas/build.js';
import type { ArtifactStatus } from '../schemas/common.js';
import type { BuildDiff } from '../schemas/diff.js';
import type {
  BuildDescription,
  ContextBundle,
  SearchRequest,
  SearchResult,
  SourceReadRequest,
  SourceReadResult,
  SourceState,
  TableDescription,
  TableQueryRequest,
  TableQueryResult,
  TaskContextRequest,
} from '../schemas/runtime.js';
import type { ActiveBuildProvider, BuildHandle, ObjectStore } from './storage.js';

/**
 * The one capability boundary MCP, REST, the CLI and Studio all call (architecture 13.1).
 *
 * It is declared here, in the package that imports no database and no protocol, because
 * the same implementation has to run on Node over SQLite and in a Worker over D1 and R2.
 * That portability is not a hope: `@lorepack/runtime` is forbidden from importing any
 * backend, so the only way it can reach data is through these ports.
 *
 * Read-only by construction. There is no build, deploy, edit or execute capability here,
 * and there is nowhere for one to be added without changing this file (invariant 10).
 */

/** A chunk as the catalog holds it. The unit every capability reads and returns. */
export interface CatalogChunk {
  readonly chunkId: string;
  readonly artifactId: string;
  readonly relativePath: string;
  readonly displayPath: string;
  readonly headingPath: readonly string[];
  /**
   * The page, for a format whose only coordinate is a page.
   *
   * An alternative to the line range, not a companion to it. A PDF has pages and no lines; a
   * Markdown file has lines and no pages. Carrying an invented one beside the real one is what
   * made a PDF citation read as line 1 (#241).
   */
  readonly page: number | null;
  /** Source coordinates, one-based. Null where the format has no lines. */
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly status: ArtifactStatus;
  /** The user-declared ranking hint, never a claim about correctness (invariant 6). */
  readonly authority: number;
  readonly estimatedTokens: number;
  /** The chunk body. Ranking needs it for near-duplicate detection, assembly for packing. */
  readonly text: string;
  /** The artifact's title, where the format has one. Ranking boosts an exact match on it. */
  readonly title: string | null;
}

export interface CatalogSearchHit extends CatalogChunk {
  /** Raw BM25 from the lexical index. Negative, and lower is better. */
  readonly bm25: number;
  readonly excerpt: string;
}

export interface CatalogSearchCriteria {
  readonly limit: number;
  /**
   * Whether a chunk must contain every term or only one. Defaults to every term.
   *
   * A keyword search wants precision. A task is a sentence, and no chunk contains all of
   * "how do I roll back a release", so assembly asks for `any` and lets ranking sort out
   * what is actually relevant.
   */
  readonly match?: 'all' | 'any' | undefined;
  readonly pathGlob?: string | undefined;
  readonly extension?: string | undefined;
  /** Exactly one artifact. Anything else is excluded, including near matches. */
  readonly artifactId?: string | undefined;
  readonly statuses?: readonly ArtifactStatus[] | undefined;
}

/**
 * Everything sealed inside one build, read through a handle.
 *
 * Methods are asynchronous even where the local implementation is synchronous, because D1
 * is not, and a port whose shape depends on its fastest implementation is not a port.
 */
export interface CatalogStore {
  manifest(): Promise<BuildManifest>;
  countChunks(): Promise<number>;
  countWarnings(): Promise<number>;
  search(query: string, criteria: CatalogSearchCriteria): Promise<readonly CatalogSearchHit[]>;
  /**
   * Artifacts this build records as superseded by some other artifact.
   *
   * A set rather than the pairs, because ranking only asks "is this one superseded". The
   * pairs matter to `lore diff` and to the Phase 5 rule resolver, which read them directly.
   */
  supersededArtifacts(): Promise<ReadonlySet<string>>;
  /** By artifact id or by canonical path. Null when the build has no such artifact. */
  artifact(idOrPath: string): Promise<CatalogArtifact | null>;
  /**
   * Every artifact in the build, in canonical order.
   *
   * This completes a port that could fetch one artifact and its nodes but not say what it
   * held. `lore inspect sources` answered that question with raw SQL against the build
   * database, underneath this interface, which meant the capability existed only for the
   * local backend and could not exist for the Phase 6 Worker at all (#66).
   *
   * On `CatalogStore` rather than on `LoreRuntime`: architecture 13.1 fixes the model-facing
   * interface at seven capabilities, and a file listing is a storage question, not a
   * retrieval one. Studio reads it through an injected host function, like the plan.
   */
  artifacts(): Promise<readonly CatalogArtifactSummary[]>;
  /** Every node of one artifact, in document order. */
  nodes(artifactId: string): Promise<readonly CatalogNode[]>;
}

/**
 * An artifact in a listing, with the facts a tree shows without opening anything.
 *
 * Wider than `CatalogArtifact` because a listing shows size, parser and chunk count in
 * columns, and fetching those per row would be one query per file at the 2,500-file envelope.
 */
export interface CatalogArtifactSummary extends CatalogArtifact {
  readonly byteSize: number;
  readonly parserId: string;
  readonly chunkCount: number;
  readonly nodeCount: number;
}

/** An artifact as the build recorded it. */
export interface CatalogArtifact {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly displayPath: string;
  readonly title: string | null;
  readonly status: ArtifactStatus;
  readonly authority: number;
  readonly mediaType: string;
  /** Where the normalized body lives in the object store. */
  readonly objectHash: string;
}

/**
 * A node of the parsed document, in source coordinates.
 *
 * The line numbers matter more than they look. They address the **source**, and the
 * normalized body has its own numbering: normalization collapses blank runs, so the two
 * diverge from the first blank line onward. Slicing the normalized body by a source line
 * range returns the wrong text, plausibly and silently, which is why a range read resolves
 * through these records instead (#44).
 */
export interface CatalogNode {
  readonly nodeId: string;
  readonly artifactId: string;
  readonly kind: string;
  readonly ordinal: number;
  readonly title: string | null;
  readonly text: string;
  readonly headingPath: readonly string[];
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
}

/**
 * Typed tables. Declared now and empty until Phase 5, so the capability surface is whole
 * and a caller learns "this build has no tables" from a typed answer rather than from a
 * missing method.
 */
export interface TableStore {
  list(): Promise<readonly { readonly tableId: string; readonly name: string }[]>;
  describe(tableId: string): Promise<StoredTableDescription | null>;
  query(request: TableQueryRequest): Promise<TableQueryResult>;
}

/**
 * What a store knows about a table, which is everything except the envelope.
 *
 * `buildId` and `sourceState` are the runtime's to stamp: a store reports what it stored,
 * and freshness is observed at request time against the source tree. The same split already
 * exists for the catalog, where `CatalogSearchHit` is deliberately narrower than
 * `SearchHit`, and it exists for the same reason: a store that had to invent a
 * `sourceState` would be answering a question it cannot see.
 */
export type StoredTableDescription = Omit<TableDescription, 'buildId' | 'sourceState'>;

/**
 * The stores for one acquired build.
 *
 * `buildId` is not decoration: the runtime asserts it against the handle it acquired
 * before reading anything, so a backend that opens the wrong build fails loudly at the
 * boundary instead of returning rows from two builds in one response (architecture 15.2).
 */
export interface BuildScope {
  readonly buildId: BuildHandle['buildId'];
  /**
   * When this build was created, if the backend keeps that record.
   *
   * Not in the manifest, and not for want of asking: a sealed build carries no wall-clock
   * time, because two builds of identical content must be identical bytes. The creation
   * time is operational state the backend holds beside the build, so a backend that has
   * no such record simply omits it.
   */
  readonly createdAt?: string | undefined;
  readonly catalog: CatalogStore;
  readonly tables: TableStore;
  readonly objects: ObjectStore;
}

/**
 * How freshness is established.
 *
 * An annotation, never a precondition. A read of a sealed build is not entitled to an
 * opinion about the source tree, and #147 was the proof: establishing freshness first made
 * `lore search` refuse to answer on a project above the file envelope, from a build that
 * was sitting there ready. A provider that cannot tell returns `unknown`, and the read
 * succeeds regardless.
 */
export type FreshnessProvider = () => Promise<SourceState>;

export interface RuntimeDeps {
  readonly provider: ActiveBuildProvider;
  /** Opens the stores for an acquired build. Called once per request. */
  readonly open: (handle: BuildHandle) => Promise<BuildScope>;
  readonly freshness?: FreshnessProvider;
}

/**
 * Architecture 13.1, exactly. Every method acquires one handle, uses it for the whole
 * call, releases it in a `finally`, and stamps the response with the build it read and the
 * freshness it observed, so no transport can forget to.
 */
export interface LoreRuntime {
  describeBuild(): Promise<BuildDescription>;
  search(request: SearchRequest): Promise<SearchResult>;
  contextForTask(request: TaskContextRequest): Promise<ContextBundle>;
  readSource(request: SourceReadRequest): Promise<SourceReadResult>;
  listTables(): Promise<readonly { readonly tableId: string; readonly name: string }[]>;
  describeTable(tableId: string): Promise<TableDescription>;
  queryTable(request: TableQueryRequest): Promise<TableQueryResult>;
}

/**
 * Comparing two builds, which is a different question from reading one.
 *
 * `LoreRuntime` is fixed at seven capabilities and every one of them reads the *active*
 * build through a handle. A diff reads two builds, neither of which need be active, and
 * possibly after the sources are gone. So it is a separate, optional port, supplied by a
 * host that can reach build history: the local CLI can, and a deployment that keeps only
 * the build it serves cannot, which is exactly the distinction a separate port expresses.
 *
 * Read-only, like everything at the AI boundary (invariant 10). Comparing builds cannot
 * create, activate or delete one.
 */
export interface BuildComparer {
  compare(fromBuildId: string, toBuildId: string): Promise<BuildDiff>;
}
