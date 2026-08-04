import {
  type ArtifactParser,
  LoreError,
  type ParsedArtifact,
  type ParseInput,
  type ParserWarning,
} from '@lorepack/core';
import { parseHtmlSource } from '../html/parser.js';

export const DOCX_PARSER_ID = 'docx' as const;
/**
 * Bumping this invalidates every cached parse and changes the build id.
 *
 * mammoth's version belongs to this number too: a change to how it maps a Word style to HTML
 * changes the nodes a build contains, and the dependency is pinned for that reason.
 */
export const DOCX_PARSER_VERSION = '0.1.0' as const;

/**
 * DOCX to the canonical node tree, by way of HTML.
 *
 * mammoth converts, and the **HTML parser builds the nodes**. That is the whole design: one
 * set of node-construction rules and one normalization path, rather than a second structure
 * extractor that drifts from the first. It is also why #71 landed before this.
 *
 * mammoth is chosen because it maps Word **styles** to semantics rather than reproducing
 * visual formatting. A heading in Word is a paragraph wearing the `Heading1` style, not text
 * that happens to be large, so the mapping is reading what the author declared rather than
 * guessing from appearance. That is section 4.4's requirement, and it is the same reason the
 * PDF parser refuses to infer headings: there, no declaration exists to read.
 *
 * **A DOCX has no pages.** Word paginates at render time against a page size, a font set and a
 * printer, so a page number is a property of a rendering rather than of the document. Locators
 * therefore carry the heading path and the ordinal position, and the absence of pages is
 * recorded in metadata rather than faked.
 */
export const docxParser: ArtifactParser = {
  id: DOCX_PARSER_ID,
  version: DOCX_PARSER_VERSION,

  supports(input) {
    return (
      input.mediaType ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      /\.docx$/i.test(input.relativePath)
    );
  },

  async parse(input: ParseInput): Promise<ParsedArtifact> {
    assertNotLegacyDoc(input);

    const warnings: ParserWarning[] = [];
    const html = await convert(input, warnings);

    const parsed = parseHtmlSource(input, html, docxParser, warnings);
    return {
      ...parsed,
      artifact: {
        ...parsed.artifact,
        // The HTML parser has no filename-derived title worth keeping here: a Word document's
        // first heading is the better answer, and `titleFrom` already prefers it.
        metadata: {
          ...parsed.artifact.metadata,
          // Stated rather than omitted. A reader who expects `page` in a locator should find
          // out why it is absent from the build, not from a support thread.
          pagination: 'none: a DOCX is paginated at render time, so it has no page numbers',
        },
      },
      warnings,
    };
  },
};

/**
 * The legacy binary format, refused by name.
 *
 * `.doc` is a completely different format that happens to share three letters. Letting it
 * reach mammoth produces "could not find the body element", which sends someone looking for a
 * corrupt file rather than for a save-as.
 */
function assertNotLegacyDoc(input: ParseInput): void {
  if (!/\.doc$/i.test(input.relativePath)) return;
  throw new LoreError(
    'LORE_E_UNSUPPORTED_FORMAT',
    `${input.displayPath} is a legacy .doc file, which is a different format from .docx.`,
    {
      remediation:
        'Open it and save as .docx, then rebuild. The two share a name and nothing else, so Lorepack refuses rather than guessing.',
      path: input.displayPath,
    },
  );
}

async function convert(input: ParseInput, warnings: ParserWarning[]): Promise<string> {
  const mammoth = (await import('mammoth')).default;
  try {
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(input.bytes) });
    recordStyleWarnings(result.messages, warnings);
    return result.value;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // A password-protected DOCX is an OLE container rather than a ZIP, so it fails at the
    // archive layer with a message about the central directory. Naming the likely cause is
    // more use than passing that through.
    if (/end of central directory|zip|encrypted/i.test(message)) {
      throw new LoreError(
        'LORE_E_UNSUPPORTED_FORMAT',
        `${input.displayPath} is not a readable .docx archive.`,
        {
          remediation:
            'It may be corrupt, or password-protected, which Lorepack never prompts for. Open it to confirm, remove any password, or exclude it in .loreignore.',
          path: input.displayPath,
          cause,
        },
      );
    }
    throw new LoreError('LORE_E_PARSE_FAILED', `${input.displayPath} could not be converted.`, {
      remediation: 'Open the document to confirm it is intact, or exclude it in .loreignore.',
      path: input.displayPath,
      cause,
    });
  }
}

/**
 * mammoth's messages, turned into warnings that name the styles.
 *
 * #73 asks for unmapped styles to be listed rather than silently flattened, and this is the
 * only place that information exists: once the HTML is produced, a paragraph that was styled
 * `CustomCallout` is indistinguishable from one that was not styled at all. Deduplicated and
 * sorted, because a document with two hundred paragraphs in one custom style should produce
 * one warning rather than two hundred.
 */
function recordStyleWarnings(
  messages: readonly { type: string; message: string }[],
  warnings: ParserWarning[],
): void {
  const styles = new Set<string>();
  const others: string[] = [];

  for (const message of messages) {
    const named = /Unrecognised (?:paragraph|run|table) style: .*\(Style ID: ([^)]+)\)/.exec(
      message.message,
    );
    if (named?.[1] !== undefined) {
      styles.add(named[1]);
      continue;
    }
    // "referenced but not defined" is the same fact from the other direction and would double
    // every warning, so it is folded into the set rather than reported separately.
    const referenced = /style with ID ([^ ]+) was referenced but not defined/.exec(message.message);
    if (referenced?.[1] !== undefined) continue;
    if (message.type === 'warning') others.push(message.message);
  }

  if (styles.size > 0) {
    warnings.push({
      code: 'docx-unmapped-style',
      message: `These Word styles have no semantic equivalent and were flattened to plain paragraphs: ${[
        ...styles,
      ]
        .sort()
        .join(', ')}.`,
      line: 1,
    });
  }
  for (const message of [...new Set(others)].sort()) {
    warnings.push({ code: 'docx-conversion', message, line: 1 });
  }
}
