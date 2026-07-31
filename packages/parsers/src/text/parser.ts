import type {
  ArtifactParser,
  LoreNode,
  ParsedArtifact,
  ParseInput,
  ParserWarning,
} from '@lorepack/core';
import { formatFor } from '../registry.js';
import { buildArtifact, NodeBuilder } from '../shared/builder.js';
import { decodeUtf8Strict, normalizeLineEndings, splitParagraphs } from '../shared/text.js';

export const TEXT_PARSER_ID = 'text' as const;
export const CODE_PARSER_ID = 'code' as const;
export const TEXT_PARSER_VERSION = '0.1.0' as const;

/**
 * Architecture section 8.7 is explicit that v0.1 needs no AST for code: paragraph or
 * syntax-neutral region splitting is enough. That is a deliberate limit, not a shortcut.
 * Every language behaves identically, there is no per-language maintenance, and nothing
 * pretends to understand structure it has not parsed.
 */

/** A single line beyond this is split, so one minified file cannot dominate a build. */
const MAX_LINE_CHARACTERS = 20_000;

function isCode(relativePath: string): boolean {
  return formatFor(relativePath.split('/').at(-1) ?? relativePath)?.parserId === 'code';
}

export const textParser: ArtifactParser = {
  id: TEXT_PARSER_ID,
  version: TEXT_PARSER_VERSION,

  supports(input) {
    const entry = formatFor(input.relativePath.split('/').at(-1) ?? input.relativePath);
    return entry?.parserId === 'text' || entry?.parserId === 'code';
  },

  parse(input: ParseInput): ParsedArtifact {
    const decoded = normalizeLineEndings(decodeUtf8Strict(input.bytes, input.displayPath));
    const warnings: ParserWarning[] = [];
    const code = isCode(input.relativePath);
    const { text, split } = boundLongLines(decoded);
    if (split > 0) {
      warnings.push({
        code: 'long-line-split',
        message: `${split} line(s) longer than ${MAX_LINE_CHARACTERS.toLocaleString('en-US')} characters were split, which changes how the text is chunked but not its content.`,
      });
    }

    const builder = new NodeBuilder(input);
    const filename = input.relativePath.split('/').at(-1) ?? input.relativePath;
    const title = filename.replace(/\.[^.]+$/, '') || filename;

    const root = builder.add({
      ordinalPath: [0],
      kind: 'document',
      title,
      lineStart: 1,
      lineEnd: Math.max(1, text.split('\n').length),
      metadata: code ? languageMetadata(filename) : {},
    });

    const regions = splitParagraphs(text);
    for (const [index, region] of regions.entries()) {
      builder.add({
        ordinalPath: [0, index + 1],
        // Code regions keep their exact text, so indentation and blank-line structure
        // inside a block survive. Prose is a paragraph.
        kind: code ? 'code' : 'paragraph',
        parentId: root.id,
        text: region.text,
        lineStart: region.line,
        lineEnd: region.line + region.text.split('\n').length - 1,
      });
    }

    if (regions.length === 0) {
      warnings.push({ code: 'empty-file', message: 'The file has no content to index.' });
    }

    return {
      artifact: buildArtifact(
        input,
        { id: code ? CODE_PARSER_ID : TEXT_PARSER_ID, version: TEXT_PARSER_VERSION },
        {
          title,
          metadata: code ? languageMetadata(filename) : {},
        },
      ),
      nodes: builder.nodes as LoreNode[],
      warnings,
    };
  },
};

/** Splits pathological lines at a documented boundary rather than holding them in memory. */
function boundLongLines(text: string): { text: string; split: number } {
  if (!text.split('\n').some((line) => line.length > MAX_LINE_CHARACTERS)) {
    return { text, split: 0 };
  }
  const out: string[] = [];
  let split = 0;
  for (const line of text.split('\n')) {
    if (line.length <= MAX_LINE_CHARACTERS) {
      out.push(line);
      continue;
    }
    split += 1;
    for (let i = 0; i < line.length; i += MAX_LINE_CHARACTERS) {
      out.push(line.slice(i, i + MAX_LINE_CHARACTERS));
    }
  }
  return { text: out.join('\n'), split };
}

function languageMetadata(filename: string): Record<string, unknown> {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? { language: filename.slice(dot + 1).toLowerCase() } : {};
}
