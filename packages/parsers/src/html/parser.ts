import type {
  ArtifactParser,
  LoreNode,
  ParsedArtifact,
  ParseInput,
  ParserWarning,
} from '@lorepack/core';
import type { Element, Root, RootContent, Text } from 'hast';
import rehypeParse from 'rehype-parse';
import { unified } from 'unified';
import { buildArtifact, NodeBuilder } from '../shared/builder.js';
import { normalizeLineEndings } from '../shared/text.js';
import { decodeHtml } from './encoding.js';
import {
  CHROME,
  CONTENT_LANDMARKS,
  DROPPED_WITH_CONTENT,
  HTML_NOISE_POLICY_VERSION,
  SUBSTANTIAL_REMOVAL_FRACTION,
} from './policy.js';

export const HTML_PARSER_ID = 'html' as const;
/**
 * Bumping this invalidates every cached parse and changes the build id.
 *
 * The noise policy is part of what this version covers, because removing an element changes
 * the nodes a build contains. Editing `policy.ts` without bumping here would let two builds
 * with the same id hold different text.
 */
export const HTML_PARSER_VERSION = '0.1.0' as const;

/**
 * `fragment: false` parses as a whole document, which is what makes the HTML spec's error
 * recovery apply: an unclosed tag or a stray `</div>` is repaired the way a browser repairs
 * it rather than failing. Malformed markup is the normal case, not the exceptional one.
 */
const processor = unified().use(rehypeParse, { fragment: false });

const DROPPED = new Set(DROPPED_WITH_CONTENT);
const CHROME_TAGS = new Set(CHROME);
const LANDMARKS = new Set(CONTENT_LANDMARKS);
const HEADINGS = new Map([
  ['h1', 1],
  ['h2', 2],
  ['h3', 3],
  ['h4', 4],
  ['h5', 5],
  ['h6', 6],
]);
const BLOCKS = new Map<string, 'paragraph' | 'list' | 'code' | 'table'>([
  ['p', 'paragraph'],
  ['blockquote', 'paragraph'],
  ['dd', 'paragraph'],
  ['dt', 'paragraph'],
  ['figcaption', 'paragraph'],
  ['ul', 'list'],
  ['ol', 'list'],
  ['dl', 'list'],
  ['pre', 'code'],
  ['table', 'table'],
]);

interface Frame {
  readonly depth: number;
  readonly id: string;
  readonly titles: readonly string[];
  readonly ordinalPath: readonly number[];
  children: number;
}

/**
 * HTML to the canonical node tree.
 *
 * rehype is the same unified toolchain the Markdown parser uses, so heading stacking, node
 * ids and locator construction are shared rather than reimplemented, and it exposes source
 * positions, which is what makes exact line ranges possible.
 *
 * This parser is also the one DOCX normalizes through (#73), so every decision here is made
 * twice: once for a `.html` file and once for a Word document that became HTML.
 */
export const htmlParser: ArtifactParser = {
  id: HTML_PARSER_ID,
  version: HTML_PARSER_VERSION,

  supports(input) {
    return input.mediaType === 'text/html' || /\.html?$/i.test(input.relativePath);
  },

  parse(input: ParseInput): ParsedArtifact {
    const warnings: ParserWarning[] = [];
    const raw = normalizeLineEndings(decodeHtml(input.bytes, input.displayPath, warnings));
    const tree = processor.parse(raw) as Root;

    const builder = new NodeBuilder(input);
    const documentTitle = titleFrom(tree, input.relativePath);

    const root = builder.add({
      ordinalPath: [0],
      kind: 'document',
      ...(documentTitle === undefined ? {} : { title: documentTitle }),
      lineStart: 1,
      lineEnd: tree.position?.end?.line ?? raw.split('\n').length,
      metadata: { noisePolicyVersion: HTML_NOISE_POLICY_VERSION },
    });

    const stack: Frame[] = [{ depth: 0, id: root.id, titles: [], ordinalPath: [0], children: 0 }];
    const removed = { characters: 0, elements: new Set<string>() };
    const kept = { characters: 0 };

    walk(bodyOf(tree) ?? tree, { builder, stack, removed, kept, warnings, inContent: false });

    reportRemoval(kept, removed, warnings);

    return {
      artifact: buildArtifact(input, htmlParser, {
        ...(documentTitle === undefined ? {} : { title: documentTitle }),
        metadata: { noisePolicyVersion: HTML_NOISE_POLICY_VERSION },
      }),
      nodes: builder.nodes as LoreNode[],
      warnings,
    };
  },
};

interface WalkState {
  readonly builder: NodeBuilder;
  readonly stack: Frame[];
  readonly removed: { characters: number; elements: Set<string> };
  /** Text that reached a node. Counted as it is emitted, because the tree is never mutated. */
  readonly kept: { characters: number };
  readonly warnings: ParserWarning[];
  /** True once inside `article` or `main`, where a `header` is the content's own. */
  readonly inContent: boolean;
}

function walk(parent: Root | Element, state: WalkState): void {
  for (const child of parent.children) {
    if (child.type !== 'element') continue;
    const element = child as Element;
    const tag = element.tagName.toLowerCase();

    if (DROPPED.has(tag) || (CHROME_TAGS.has(tag) && !state.inContent)) {
      state.removed.characters += textOf(element).length;
      state.removed.elements.add(tag);
      continue;
    }

    const heading = HEADINGS.get(tag);
    if (heading !== undefined) {
      pushHeading(element, heading, state);
      continue;
    }

    const kind = BLOCKS.get(tag);
    if (kind !== undefined) {
      emit(element, kind, state);
      continue;
    }

    // A structural wrapper: descend rather than emit. `div`, `section`, `article` and every
    // unknown element land here, which is why an unfamiliar tag keeps its text.
    walk(element, { ...state, inContent: state.inContent || LANDMARKS.has(tag) });
  }
}

function pushHeading(element: Element, depth: number, state: WalkState): void {
  const title = textOf(element).trim();
  state.kept.characters += title.length;

  // Same rule as Markdown: an h1 followed by an h3 nests, because inventing an h2 would
  // invent structure the author did not write.
  while (state.stack.length > 1 && (state.stack.at(-1) as Frame).depth >= depth) state.stack.pop();
  const parent = state.stack.at(-1) as Frame;
  parent.children += 1;

  const ordinalPath = [...parent.ordinalPath, parent.children];
  const titles = [...parent.titles, title];
  const node = state.builder.add({
    ordinalPath,
    kind: 'section',
    parentId: parent.id,
    title,
    headingPath: parent.titles,
    lineStart: element.position?.start.line ?? 1,
    lineEnd: element.position?.end.line ?? 1,
    metadata: { depth },
  });

  if (title === '') {
    state.warnings.push({
      code: 'empty-heading',
      message: 'A heading has no text, so it contributes nothing to the heading path.',
      line: element.position?.start.line ?? 1,
    });
  }

  state.stack.push({ depth, id: node.id, titles, ordinalPath, children: 0 });
}

function emit(
  element: Element,
  kind: 'paragraph' | 'list' | 'code' | 'table',
  state: WalkState,
): void {
  const text = kind === 'code' ? exactText(element) : textOf(element).trim();
  if (text === '') return;
  state.kept.characters += text.length;

  const parent = state.stack.at(-1) as Frame;
  parent.children += 1;
  state.builder.add({
    ordinalPath: [...parent.ordinalPath, parent.children],
    kind,
    parentId: parent.id,
    text,
    headingPath: parent.titles,
    lineStart: element.position?.start.line ?? 1,
    lineEnd: element.position?.end.line ?? 1,
    metadata: metadataFor(element, kind),
  });
}

function metadataFor(element: Element, kind: string): Record<string, unknown> {
  if (kind === 'list') {
    return {
      ordered: element.tagName.toLowerCase() === 'ol',
      items: element.children.filter(
        (child) => child.type === 'element' && (child as Element).tagName.toLowerCase() === 'li',
      ).length,
    };
  }
  if (kind === 'table') {
    return { rows: countRows(element) };
  }
  if (kind === 'code') {
    const code = firstElement(element, 'code');
    const className = code?.properties?.className;
    const language = Array.isArray(className)
      ? className
          .map(String)
          .find((name) => name.startsWith('language-'))
          ?.slice('language-'.length)
      : undefined;
    return language === undefined || language === '' ? {} : { language };
  }

  // Links are kept as metadata rather than inlined into the text, so a reader can follow
  // one without the prose being polluted by URLs (#71). Deduplicated and ordered as they
  // appear, because a node's metadata is hashed into its revision.
  const hrefs = linksIn(element);
  return hrefs.length === 0 ? {} : { links: hrefs };
}

function linksIn(element: Element): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (node: RootContent | Element): void => {
    if (node.type !== 'element') return;
    const current = node as Element;
    if (current.tagName.toLowerCase() === 'a') {
      const href = current.properties?.href;
      if (typeof href === 'string' && href !== '' && !seen.has(href)) {
        seen.add(href);
        found.push(href);
      }
    }
    for (const child of current.children) visit(child);
  };
  visit(element);
  return found;
}

function countRows(element: Element): number {
  let rows = 0;
  const visit = (node: RootContent | Element): void => {
    if (node.type !== 'element') return;
    const current = node as Element;
    if (current.tagName.toLowerCase() === 'tr') rows += 1;
    for (const child of current.children) visit(child);
  };
  visit(element);
  return rows;
}

function firstElement(element: Element, tag: string): Element | null {
  for (const child of element.children) {
    if (child.type === 'element' && (child as Element).tagName.toLowerCase() === tag) {
      return child as Element;
    }
  }
  return null;
}

/**
 * Visible text, with elements the policy drops contributing nothing.
 *
 * Nothing here can emit markup: only `text` nodes are read, so an attribute, a comment or a
 * `<script>` body cannot reach a node's text however the document is shaped. That is the
 * security property #71 asks for, and it holds by construction rather than by sanitising.
 */
function textOf(node: RootContent | Element | Root): string {
  const parts: string[] = [];
  const visit = (current: RootContent | Element | Root): void => {
    if (current.type === 'text') {
      parts.push((current as Text).value);
      return;
    }
    if (current.type !== 'element' && current.type !== 'root') return;
    const element = current as Element;
    if (current.type === 'element' && DROPPED.has(element.tagName.toLowerCase())) return;
    for (const child of (current as Root | Element).children) {
      visit(child);
      // A block boundary is a line break, so `<li>a</li><li>b</li>` does not become "ab".
      // Marked rather than written, because the collapse below cannot otherwise tell a
      // newline that means "new block" from one that is just how the source was wrapped.
      if (child.type === 'element' && isBlock((child as Element).tagName)) parts.push(BREAK);
    }
  };
  visit(node);
  return collapse(parts.join(''));
}

/**
 * A block boundary, distinguishable from source whitespace until the collapse resolves it.
 *
 * A control character rather than a newline, because the whole job of `collapse` is to tell
 * "this is a new block" apart from "the author wrapped the line here", and a newline cannot
 * carry that distinction. It never survives: `collapse` splits on it and rebuilds.
 */
const BREAK = '\u0000';

/** Code keeps its exact text, including indentation and newlines. */
function exactText(element: Element): string {
  const parts: string[] = [];
  const visit = (current: RootContent | Element): void => {
    if (current.type === 'text') {
      parts.push((current as Text).value);
      return;
    }
    if (current.type !== 'element') return;
    if (DROPPED.has((current as Element).tagName.toLowerCase())) return;
    for (const child of (current as Element).children) visit(child);
  };
  visit(element);
  return parts.join('').replace(/^\n+|\s+$/g, '');
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'li',
  'tr',
  'td',
  'th',
  'section',
  'article',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'br',
  'dd',
  'dt',
]);

function isBlock(tagName: string): boolean {
  return BLOCK_TAGS.has(tagName.toLowerCase());
}

/**
 * HTML collapses whitespace, so node text matches what a reader sees rather than how the
 * source happened to be wrapped.
 *
 * The order matters. **Every** run of source whitespace, newlines included, becomes a single
 * space first: inside a paragraph a line break in the markup is not a line break on the page.
 * Only then do the block markers become real newlines. Doing it the other way round leaves
 * `lots\n   of` as two lines, which is precisely what a browser does not render.
 */
function collapse(text: string): string {
  return text
    .split(BREAK)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter((block) => block !== '')
    .join('\n')
    .trim();
}

function bodyOf(tree: Root): Element | null {
  const find = (node: Root | Element): Element | null => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      const element = child as Element;
      if (element.tagName.toLowerCase() === 'body') return element;
      const nested = find(element);
      if (nested !== null) return nested;
    }
    return null;
  };
  return find(tree);
}

/** `<title>`, then the first heading, then the filename. Documented order, same as Markdown. */
function titleFrom(tree: Root, relativePath: string): string | undefined {
  const titleElement = findElement(tree, 'title');
  if (titleElement !== null) {
    const text = textOf(titleElement).trim();
    if (text !== '') return text;
  }

  for (const tag of HEADINGS.keys()) {
    const heading = findElement(bodyOf(tree) ?? tree, tag);
    if (heading !== null) {
      const text = textOf(heading).trim();
      if (text !== '') return text;
    }
  }

  const filename = relativePath.split('/').at(-1) ?? relativePath;
  const withoutExtension = filename.replace(/\.[^.]+$/, '');
  return withoutExtension === '' ? undefined : withoutExtension;
}

function findElement(node: Root | Element, tag: string): Element | null {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    const element = child as Element;
    if (element.tagName.toLowerCase() === tag) return element;
    const nested = findElement(element, tag);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * A page that is mostly chrome is a page whose build will disappoint someone.
 *
 * Reported as a warning rather than silently, because "why is half my page missing" is a
 * question the build should answer before it is asked (§24.4).
 */
function reportRemoval(
  kept: { characters: number },
  removed: { characters: number; elements: Set<string> },
  warnings: ParserWarning[],
): void {
  if (removed.characters === 0) return;
  const total = kept.characters + removed.characters;
  if (total === 0 || removed.characters / total < SUBSTANTIAL_REMOVAL_FRACTION) return;

  const names = [...removed.elements].sort().join(', ');
  warnings.push({
    code: 'html-noise-removed',
    message: `Most of this page was navigation or scripting and was not indexed (${names}).`,
    line: 1,
  });
}
