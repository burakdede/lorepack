import type { ArtifactStatus, SourceLocator } from '../schemas/common.js';

/**
 * The canonical model. Architecture section 10 is explicit that this matters more than any
 * retrieval index: chunks and FTS rows are projections of these records, and can be
 * rebuilt, while the structure here is what the build actually preserves.
 */

export type NodeKind =
  | 'document'
  | 'section'
  | 'paragraph'
  | 'list'
  | 'code'
  | 'table'
  | 'sheet'
  | 'row-group';

export interface Artifact {
  readonly id: string;
  readonly sourceId: string;
  /** POSIX, relative to the source root. */
  readonly relativePath: string;
  /** Native separators, for user-facing output only. */
  readonly displayPath: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly parserId: string;
  readonly parserVersion: string;
  readonly title?: string;
  readonly status: ArtifactStatus;
  /** 0..100 ranking hint declared by the user. Never evidence that content is true. */
  readonly authority: number;
  readonly supersedes: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface LoreNode {
  readonly id: string;
  readonly artifactId: string;
  readonly parentId?: string;
  readonly kind: NodeKind;
  /** Position among siblings. Stable across runs, which is what makes ids stable. */
  readonly ordinal: number;
  readonly title?: string;
  readonly text?: string;
  readonly locator: SourceLocator;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly revisionHash: string;
}

export interface ParserWarning {
  readonly code: string;
  readonly message: string;
  readonly line?: number;
}

export interface ParsedArtifact {
  readonly artifact: Artifact;
  readonly nodes: readonly LoreNode[];
  readonly warnings: readonly ParserWarning[];
  /**
   * Typed tables this artifact contains, if any.
   *
   * Separate from `nodes` on purpose, and it is the whole of architecture section 4.6: a
   * spreadsheet flattened into prose nodes is an invalid implementation. The nodes carry a
   * compact *description* of the table so retrieval can find it; the rows live here, and
   * reach the reader through SQL rather than through search.
   *
   * Optional so a Markdown parser is not obliged to say `tables: []`.
   */
  readonly tables?: readonly ParsedTable[];
}

/** A cell. The set is deliberately the SQLite storage classes plus a decoded boolean. */
export type TableValue = string | number | boolean | null;

/**
 * One typed table, ready for storage.
 *
 * `tableId` is the stable identity a caller passes to `describeTable` and `queryTable`, and
 * it is derived from the artifact and the sheet rather than from a physical SQL name. The
 * physical name is a storage detail that the backend generates and validates, and letting a
 * user address it directly would be handing them an identifier that came from their own file.
 */
export interface ParsedTable {
  readonly tableId: string;
  /** For display and for `listTables`. Human-facing; never used to build SQL. */
  readonly name: string;
  /** The worksheet, where the format has them. A CSV file is one unnamed table. */
  readonly sheet?: string;
  readonly columns: readonly ParsedColumn[];
  readonly rows: readonly (readonly TableValue[])[];
  readonly locator: SourceLocator;
  /** How the table was read: delimiter, header decision, inference sample size. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ParsedColumn {
  readonly name: string;
  readonly type: ColumnTypeName;
  readonly nullable: boolean;
  readonly statistics: ColumnStatistics;
}

/** Mirrors `columnTypeSchema`, declared here so the model does not import a Zod schema. */
export type ColumnTypeName = 'text' | 'integer' | 'real' | 'boolean' | 'date' | 'unknown';

/**
 * What `describeTable` reports without reading the rows.
 *
 * `distinctEstimate` is named an estimate because at the 500,000-row envelope an exact
 * count is a second pass over every value. It is exact below a bounded cardinality and a
 * lower bound above it, and which of the two applies is recorded rather than left to guess.
 */
export interface ColumnStatistics {
  readonly nullCount: number;
  readonly distinctEstimate: number;
  readonly distinctIsExact: boolean;
  readonly min?: TableValue;
  readonly max?: TableValue;
}

/** What a parser is handed. Pure input: no filesystem access, no clock, no configuration. */
export interface ParseInput {
  readonly artifactId: string;
  readonly sourceId: string;
  readonly relativePath: string;
  readonly displayPath: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly bytes: Uint8Array;
}

/**
 * The parser port. Implementations are pure functions of their input, which is what makes
 * them deterministic by construction and trivial to fixture-test.
 *
 * `version` is part of the cache key and the build id, so bumping it is a deliberate act
 * that invalidates every artifact this parser produced.
 *
 * `parse` may return a promise, because two of the formats Phase 5 adds cannot be read any
 * other way: `pdfjs.getDocument()` resolves a promise and `mammoth.convertToHtml()` is a
 * thenable. Pure and asynchronous are not in tension. What "pure" is protecting is that a
 * parser reads nothing but its input, holds no state between calls, and returns the same
 * nodes for the same bytes; none of that is weakened by the work taking a tick.
 *
 * A synchronous parser needs no change: `ParsedArtifact` is assignable to
 * `ParsedArtifact | Promise<ParsedArtifact>`, so `markdownParser` and `textParser` still
 * return a value directly and their tests still read as straight-line code.
 */
export interface ArtifactParser {
  readonly id: string;
  readonly version: string;
  supports(input: { mediaType: string; relativePath: string }): boolean;
  parse(input: ParseInput): ParsedArtifact | Promise<ParsedArtifact>;
}
