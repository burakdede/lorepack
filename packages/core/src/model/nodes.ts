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
