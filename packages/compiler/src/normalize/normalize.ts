import {
  hashBytes,
  type LoreNode,
  NORMALIZATION_VERSION,
  type NodeKind,
  normalizeUnicode,
  type ObjectStore,
  type ParsedArtifact,
} from '@lorepack/core';

/**
 * Normalization decides what text a build actually stores, and it feeds every hash, so it
 * is versioned: `NORMALIZATION_VERSION` is a build id input and changing any rule here
 * changes every build id in existence.
 *
 * The whitespace policy is per node kind rather than global, because "safe to collapse"
 * is not a property of text in general. Collapsing whitespace inside a code block would
 * corrupt it; collapsing it inside a paragraph is invisible to a reader.
 */

export interface WhitespacePolicy {
  /** Collapse runs of spaces and tabs into one space. */
  readonly collapseRuns: boolean;
  /** Collapse three or more newlines into two. */
  readonly collapseBlankLines: boolean;
  readonly trimLineEnds: boolean;
}

/** The policy per node kind, as a reviewable table rather than scattered conditionals. */
export const WHITESPACE_POLICY: Readonly<Record<NodeKind, WhitespacePolicy>> = {
  document: { collapseRuns: false, collapseBlankLines: true, trimLineEnds: true },
  section: { collapseRuns: true, collapseBlankLines: true, trimLineEnds: true },
  paragraph: { collapseRuns: true, collapseBlankLines: true, trimLineEnds: true },
  list: { collapseRuns: true, collapseBlankLines: true, trimLineEnds: true },
  // Never touched. Indentation is meaning in code, and a build that silently reflows it
  // would return text that does not match the file it cites.
  code: { collapseRuns: false, collapseBlankLines: false, trimLineEnds: false },
  table: { collapseRuns: true, collapseBlankLines: true, trimLineEnds: true },
  sheet: { collapseRuns: false, collapseBlankLines: false, trimLineEnds: false },
  'row-group': { collapseRuns: false, collapseBlankLines: false, trimLineEnds: false },
};

export function normalizeText(text: string, kind: NodeKind): string {
  const policy = WHITESPACE_POLICY[kind];
  let out = normalizeUnicode(text);

  if (policy.trimLineEnds) {
    out = out
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n');
  }
  if (policy.collapseRuns) out = out.replace(/[ \t]{2,}/g, ' ');
  if (policy.collapseBlankLines) out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

export interface NormalizedArtifact {
  readonly parsed: ParsedArtifact;
  readonly nodes: readonly LoreNode[];
  /** Hash of the normalized body stored in the object store. */
  readonly objectHash: string;
  readonly objectSize: number;
}

export interface NormalizeOptions {
  readonly parsed: ParsedArtifact;
  readonly objects: ObjectStore;
}

/**
 * Normalizes node text and stores the artifact's normalized body as a content-addressed
 * object.
 *
 * The body is stored because architecture section 11.2 requires a build to serve a source
 * read without the original file. That is what lets the Cloudflare projection answer
 * `readSource` from R2, and what makes a build self-contained rather than a set of
 * pointers into someone's working directory.
 */
export async function normalizeArtifact(options: NormalizeOptions): Promise<NormalizedArtifact> {
  const { parsed, objects } = options;

  const nodes = parsed.nodes.map((node) => {
    if (node.text === undefined) return node;
    const text = normalizeText(node.text, node.kind);
    if (text === node.text) return node;
    return { ...node, text, revisionHash: hashBytes(`${node.kind} ${node.title ?? ''} ${text}`) };
  });

  const body = renderBody(nodes);
  const bytes = new TextEncoder().encode(body);
  const objectHash = await objects.put(bytes);

  return { parsed, nodes, objectHash, objectSize: bytes.byteLength };
}

/**
 * The normalized body: enough text, in document order, to answer a source read. Headings
 * are included so a range stays readable on its own.
 */
export function renderBody(nodes: readonly LoreNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'document') continue;
    if (node.kind === 'section') {
      const depth = typeof node.metadata.depth === 'number' ? node.metadata.depth : 1;
      parts.push(`${'#'.repeat(Math.min(6, Math.max(1, depth)))} ${node.title ?? ''}`.trim());
      continue;
    }
    if (node.text !== undefined && node.text !== '') parts.push(node.text);
  }
  return `${parts.join('\n\n')}\n`;
}

export { NORMALIZATION_VERSION };
