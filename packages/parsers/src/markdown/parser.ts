import type {
  ArtifactParser,
  LoreNode,
  ParsedArtifact,
  ParseInput,
  ParserWarning,
} from '@lorepack/core';
import type { Code, Heading, List, Root, RootContent, Table } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { parse as parseYaml } from 'yaml';
import { buildArtifact, NodeBuilder } from '../shared/builder.js';
import { decodeUtf8Strict, normalizeLineEndings } from '../shared/text.js';

export const MARKDOWN_PARSER_ID = 'markdown' as const;
/** Bumping this invalidates every cached parse and changes the build id. */
export const MARKDOWN_PARSER_VERSION = '0.1.0' as const;

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']);

interface Frame {
  readonly depth: number;
  readonly id: string;
  readonly titles: readonly string[];
  readonly ordinalPath: readonly number[];
  children: number;
}

/**
 * Markdown to the canonical node tree.
 *
 * unified and remark are the mature CommonMark and GFM toolchain, and they expose source
 * positions, which is what makes exact locators possible. The parser is a pure function of
 * its input: no filesystem, no clock, no configuration, so it is deterministic by
 * construction rather than by discipline.
 */
export const markdownParser: ArtifactParser = {
  id: MARKDOWN_PARSER_ID,
  version: MARKDOWN_PARSER_VERSION,

  supports(input) {
    return input.mediaType === 'text/markdown' || /\.(md|markdown|mdx)$/i.test(input.relativePath);
  },

  parse(input: ParseInput): ParsedArtifact {
    const raw = normalizeLineEndings(decodeUtf8Strict(input.bytes, input.displayPath));
    const warnings: ParserWarning[] = [];
    const tree = processor.parse(raw) as Root;

    const builder = new NodeBuilder(input);
    const frontmatter = readFrontmatter(tree, warnings);

    // The document node is the root every other node hangs from, so a build always has a
    // single entry point per artifact even when the file is empty.
    const documentTitle = titleFrom(frontmatter, tree, input.relativePath);
    const root = builder.add({
      ordinalPath: [0],
      kind: 'document',
      ...(documentTitle === undefined ? {} : { title: documentTitle }),
      lineStart: 1,
      lineEnd: lineOf(tree.position?.end?.line, raw),
      metadata: frontmatter === null ? {} : { frontmatter },
    });

    const stack: Frame[] = [{ depth: 0, id: root.id, titles: [], ordinalPath: [0], children: 0 }];

    for (const child of tree.children) {
      if (child.type === 'yaml') continue;

      if (child.type === 'heading') {
        pushHeading(child, builder, stack, raw, warnings);
        continue;
      }

      const parent = stack.at(-1) as Frame;
      const kind = kindFor(child);
      if (kind === null) continue;

      parent.children += 1;
      builder.add({
        ordinalPath: [...parent.ordinalPath, parent.children],
        kind,
        parentId: parent.id,
        text: textFor(child, raw),
        headingPath: parent.titles,
        lineStart: child.position?.start.line ?? 1,
        lineEnd: child.position?.end.line ?? 1,
        metadata: metadataFor(child),
      });
    }

    return {
      artifact: buildArtifact(input, markdownParser, {
        ...(documentTitle === undefined ? {} : { title: documentTitle }),
        ...(frontmatter === null ? {} : { metadata: frontmatter }),
      }),
      nodes: builder.nodes as LoreNode[],
      warnings,
    };
  },
};

function pushHeading(
  heading: Heading,
  builder: NodeBuilder,
  stack: Frame[],
  raw: string,
  warnings: ParserWarning[],
): void {
  const title = inlineText(heading).trim();

  // A jump from h1 straight to h3 is common and legal. Treating the h3 as a child of the
  // h1 preserves the author's intent; inventing an empty h2 would invent structure.
  while (stack.length > 1 && (stack.at(-1) as Frame).depth >= heading.depth) stack.pop();
  const parent = stack.at(-1) as Frame;
  parent.children += 1;

  const ordinalPath = [...parent.ordinalPath, parent.children];
  const titles = [...parent.titles, title];
  const node = builder.add({
    ordinalPath,
    kind: 'section',
    parentId: parent.id,
    title,
    headingPath: parent.titles,
    lineStart: heading.position?.start.line ?? 1,
    lineEnd: heading.position?.end.line ?? 1,
    metadata: { depth: heading.depth },
  });

  if (title === '') {
    warnings.push({
      code: 'empty-heading',
      message: 'A heading has no text, so it contributes nothing to the heading path.',
      line: heading.position?.start.line ?? 1,
    });
  }

  stack.push({ depth: heading.depth, id: node.id, titles, ordinalPath, children: 0 });
}

function kindFor(node: RootContent): 'paragraph' | 'list' | 'code' | 'table' | null {
  switch (node.type) {
    case 'paragraph':
    case 'blockquote':
    case 'definition':
    case 'footnoteDefinition':
      return 'paragraph';
    case 'list':
      return 'list';
    case 'code':
      return 'code';
    case 'table':
      return 'table';
    case 'thematicBreak':
    case 'html':
      return null;
    default:
      return 'paragraph';
  }
}

/**
 * Code blocks keep their exact text, including indentation. Everything else is rendered as
 * plain text: no HTML reaches node text, so an artifact cannot inject markup into output.
 */
function textFor(node: RootContent, raw: string): string {
  if (node.type === 'code') return (node as Code).value;
  return plainText(node, raw);
}

function metadataFor(node: RootContent): Record<string, unknown> {
  if (node.type === 'code') {
    const code = node as Code;
    return code.lang === null || code.lang === undefined ? {} : { language: code.lang };
  }
  if (node.type === 'list') {
    const list = node as List;
    return { ordered: list.ordered === true, items: list.children.length };
  }
  if (node.type === 'table') {
    const table = node as Table;
    return { rows: table.children.length };
  }
  return {};
}

/**
 * Text content with links preserved as their text, and no HTML passed through.
 *
 * Deliberately does not fall back to the source slice: for a heading that would turn `##`
 * with no text into the title "##". Callers that want a fallback ask for it.
 */
function inlineText(node: unknown): string {
  const parts: string[] = [];
  const visit = (current: unknown): void => {
    if (current === null || typeof current !== 'object') return;
    const record = current as { type?: string; value?: string; children?: unknown[] };

    if (record.type === 'text' || record.type === 'inlineCode') {
      parts.push(record.value ?? '');
      return;
    }
    if (record.type === 'code') {
      parts.push(record.value ?? '');
      return;
    }
    if (record.type === 'break') {
      parts.push('\n');
      return;
    }
    if (record.type === 'html') return;
    if (record.type === 'listItem') {
      const before = parts.length;
      for (const child of record.children ?? []) visit(child);
      if (parts.length > before) parts.push('\n');
      return;
    }
    if (record.type === 'paragraph' && parts.length > 0) parts.push('\n');
    for (const child of record.children ?? []) visit(child);
  };
  visit(node);
  return parts
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Inline text, or the source slice when a node carries no inline children. */
function plainText(node: unknown, raw: string): string {
  const inline = inlineText(node);
  return inline === '' ? fallbackText(node, raw) : inline;
}

/** Some nodes carry no inline children; fall back to their source slice. */
function fallbackText(node: unknown, raw: string): string {
  const position = (
    node as { position?: { start?: { offset?: number }; end?: { offset?: number } } }
  ).position;
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  if (start === undefined || end === undefined) return '';
  return raw.slice(start, end).trim();
}

function readFrontmatter(tree: Root, warnings: ParserWarning[]): Record<string, unknown> | null {
  const first = tree.children[0];
  if (first === undefined || first.type !== 'yaml') return null;
  try {
    const parsed = parseYaml((first as { value: string }).value) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push({
        code: 'frontmatter-not-a-mapping',
        message: 'Frontmatter is not a mapping, so it was ignored.',
        line: first.position?.start.line ?? 1,
      });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    // Malformed frontmatter is a warning, never a failed artifact: the document body is
    // still perfectly usable, and failing the build would be disproportionate.
    warnings.push({
      code: 'frontmatter-invalid',
      message: `Frontmatter is not valid YAML and was ignored: ${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }`,
      line: first.position?.start.line ?? 1,
    });
    return null;
  }
}

/** Frontmatter title, then the first heading, then the filename. Documented order. */
function titleFrom(
  frontmatter: Record<string, unknown> | null,
  tree: Root,
  relativePath: string,
): string | undefined {
  const declared = frontmatter?.title;
  if (typeof declared === 'string' && declared.trim() !== '') return declared.trim();

  for (const child of tree.children) {
    if (child.type === 'heading' && (child as Heading).depth === 1) {
      const text = inlineText(child).trim();
      if (text !== '') return text;
    }
  }

  const filename = relativePath.split('/').at(-1) ?? relativePath;
  const withoutExtension = filename.replace(/\.[^.]+$/, '');
  return withoutExtension === '' ? undefined : withoutExtension;
}

function lineOf(line: number | undefined, raw: string): number {
  return line ?? raw.split('\n').length;
}
