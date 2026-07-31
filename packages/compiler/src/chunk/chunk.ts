import {
  type ChunkingDefaults,
  chunkId,
  hashBytes,
  type LoreNode,
  type SourceLocator,
} from '@lorepack/core';

/**
 * Chunks are a retrieval projection, not the primary representation (architecture section
 * 10.4). The canonical model is the node tree; chunks can be rebuilt from it at any time.
 *
 * Chunking is hierarchy-aware and prefers whole semantic nodes. Splitting is a fallback
 * for a node that exceeds the hard maximum, not the default strategy, because a split
 * loses the boundary the author actually wrote.
 */

export interface Chunk {
  readonly id: string;
  readonly artifactId: string;
  readonly nodeIds: readonly string[];
  readonly headingPath: readonly string[];
  readonly text: string;
  readonly estimatedTokens: number;
  readonly locator: SourceLocator;
  readonly revisionHash: string;
}

/**
 * A deliberately conservative estimate, labelled as an estimate everywhere it surfaces.
 *
 * The package format must not depend on one vendor's tokenizer (section 13.6), so this
 * uses a character ratio tuned to over-count slightly: budgeting is safer when the
 * estimate errs high, because the failure mode is a smaller bundle rather than an
 * overflowing context window.
 */
export const CHARACTERS_PER_TOKEN = 3.6;

export function estimateTokens(text: string): number {
  if (text === '') return 0;
  // Whitespace-heavy text (code, tables) tokenizes worse than prose, so count a floor of
  // one token per whitespace-delimited word as well.
  const byCharacters = Math.ceil(text.length / CHARACTERS_PER_TOKEN);
  const byWords = text.split(/\s+/).filter(Boolean).length;
  return Math.max(byCharacters, byWords);
}

export interface ChunkOptions {
  readonly artifactId: string;
  readonly nodes: readonly LoreNode[];
  readonly chunking: ChunkingDefaults;
}

interface Pending {
  nodeIds: string[];
  texts: string[];
  headingPath: readonly string[];
  tokens: number;
  lineStart: number;
  lineEnd: number;
}

export function chunkArtifact(options: ChunkOptions): Chunk[] {
  const { artifactId, nodes, chunking } = options;
  const chunks: Chunk[] = [];
  let pending: Pending | null = null;

  const flush = (): void => {
    if (pending === null || pending.texts.length === 0) {
      pending = null;
      return;
    }
    chunks.push(makeChunk(artifactId, chunks.length, pending, nodes));
    pending = null;
  };

  for (const node of nodes) {
    if (node.kind === 'document' || node.text === undefined || node.text === '') continue;

    const headingPath = node.locator.headingPath ?? [];
    const prefix = renderHeadingPrefix(headingPath);
    const tokens = estimateTokens(node.text);

    // A node bigger than the hard maximum is split, and only then does overlap apply.
    if (tokens + estimateTokens(prefix) > chunking.maximumTokens) {
      flush();
      for (const piece of splitNode(node, chunking, prefix)) {
        chunks.push(makeChunk(artifactId, chunks.length, piece, nodes));
      }
      continue;
    }

    // Never join content from two different heading paths: a chunk that spans sections
    // reads as though the author wrote it that way.
    if (pending !== null && !samePath(pending.headingPath, headingPath)) flush();

    if (pending !== null && pending.tokens + tokens > chunking.targetTokens) {
      flush();
    }

    if (pending === null) {
      pending = {
        nodeIds: [],
        texts: [],
        headingPath,
        tokens: estimateTokens(prefix),
        lineStart: node.locator.lineStart ?? 1,
        lineEnd: node.locator.lineEnd ?? node.locator.lineStart ?? 1,
      };
    }

    pending.nodeIds.push(node.id);
    pending.texts.push(node.text);
    pending.tokens += tokens;
    pending.lineEnd = node.locator.lineEnd ?? pending.lineEnd;
  }

  flush();
  return chunks;
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** A small parent-heading prefix, so a retrieved chunk carries its own context. */
export function renderHeadingPrefix(headingPath: readonly string[]): string {
  return headingPath.length === 0 ? '' : `${headingPath.join(' > ')}\n\n`;
}

function makeChunk(
  artifactId: string,
  index: number,
  pending: Pending,
  nodes: readonly LoreNode[],
): Chunk {
  const prefix = renderHeadingPrefix(pending.headingPath);
  const text = `${prefix}${pending.texts.join('\n\n')}`;
  const first = nodes.find((node) => node.id === pending.nodeIds[0]);

  return {
    id: chunkId(artifactId, index),
    artifactId,
    nodeIds: [...pending.nodeIds],
    headingPath: [...pending.headingPath],
    text,
    estimatedTokens: estimateTokens(text),
    locator: {
      artifactId,
      relativePath: first?.locator.relativePath ?? '',
      ...(pending.headingPath.length > 0 ? { headingPath: [...pending.headingPath] } : {}),
      lineStart: pending.lineStart,
      lineEnd: pending.lineEnd,
    },
    revisionHash: hashBytes(text),
  };
}

/**
 * Splits one oversized node. Overlap exists only here, and is capped, because it is a
 * concession to a boundary the author did not provide rather than a retrieval technique.
 */
function splitNode(node: LoreNode, chunking: ChunkingDefaults, prefix: string): Pending[] {
  const text = node.text ?? '';
  const headingPath = node.locator.headingPath ?? [];
  const budget = Math.max(1, chunking.maximumTokens - estimateTokens(prefix));
  const maxCharacters = Math.floor(budget * CHARACTERS_PER_TOKEN);
  const overlapCharacters = Math.floor(
    Math.min(chunking.overlapTokens, budget / 2) * CHARACTERS_PER_TOKEN,
  );

  const pieces: Pending[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + maxCharacters);
    const boundary = end === text.length ? end : findBoundary(text, start, end);
    const slice = text.slice(start, boundary);

    pieces.push({
      nodeIds: [node.id],
      texts: [slice],
      headingPath,
      tokens: estimateTokens(slice),
      lineStart: node.locator.lineStart ?? 1,
      lineEnd: node.locator.lineEnd ?? node.locator.lineStart ?? 1,
    });

    if (boundary >= text.length) break;
    start = Math.max(boundary - overlapCharacters, boundary === start ? start + 1 : boundary);
  }
  return pieces;
}

/** Prefers a paragraph break, then a line break, then a space, then a hard cut. */
function findBoundary(text: string, start: number, end: number): number {
  const window = text.slice(start, end);
  const floor = Math.floor(window.length * 0.5);
  for (const separator of ['\n\n', '\n', ' ']) {
    const index = window.lastIndexOf(separator);
    if (index > floor) return start + index + separator.length;
  }
  return end;
}
