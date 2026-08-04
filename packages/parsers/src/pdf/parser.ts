// Must be first: it installs the globals the pdfjs module body needs at import time.
import './runtime.js';
import {
  type ArtifactParser,
  LoreError,
  type LoreNode,
  type ParsedArtifact,
  type ParseInput,
  type ParserWarning,
} from '@lorepack/core';
import { buildArtifact, NodeBuilder } from '../shared/builder.js';
import { normalizePageText, PDF_LIMITS } from './text.js';

export const PDF_PARSER_ID = 'pdf-text' as const;
/**
 * Bumping this invalidates every cached parse and changes the build id.
 *
 * The text normalization policy in `text.ts` is part of what this version covers, because
 * de-hyphenating a line changes the text a build contains.
 */
export const PDF_PARSER_VERSION = '0.1.0' as const;

/**
 * Text-layer PDF to the canonical node tree.
 *
 * **Text only.** Section 5.2 puts OCR and scanned documents out of scope, and this parser
 * holds that line rather than blurring it: a page with no text layer is reported as such, and
 * a document that is entirely image-based is refused with a message that says OCR is out of
 * scope. Producing an empty artifact instead would be the worst outcome, because an empty
 * build looks like a working one.
 *
 * **No inferred headings.** Section 4.4 is about structure being preserved rather than
 * invented, and a PDF has no headings, only text that happens to be larger. Inferring a
 * hierarchy from font size would put a structure in the build that is not in the document,
 * and every locator under it would be a claim nobody made. So a page is a page: one `section`
 * per page, carrying the page number, and paragraphs under it.
 */
export const pdfParser: ArtifactParser = {
  id: PDF_PARSER_ID,
  version: PDF_PARSER_VERSION,

  supports(input) {
    return input.mediaType === 'application/pdf' || /\.pdf$/i.test(input.relativePath);
  },

  async parse(input: ParseInput): Promise<ParsedArtifact> {
    const warnings: ParserWarning[] = [];
    const { document, task } = await open(input);

    try {
      const pageCount = document.numPages;
      if (pageCount > PDF_LIMITS.warnPages) {
        warnings.push({
          code: 'pdf-large-document',
          message: `This document has ${pageCount} pages, beyond the ${PDF_LIMITS.warnPages} the scale envelope covers. It was read in full; extraction time grows with the page count.`,
          line: 1,
        });
      }
      if (pageCount > PDF_LIMITS.maxPages) {
        throw new LoreError(
          'LORE_E_UNSUPPORTED_FORMAT',
          `${input.displayPath} has ${pageCount} pages, above the ${PDF_LIMITS.maxPages} page cap.`,
          {
            remediation:
              'Split the document, or exclude it in .loreignore. The cap exists because extraction is linear in pages and a build should not hang on one file.',
            path: input.displayPath,
          },
        );
      }

      const builder = new NodeBuilder(input);
      const title = await titleFor(document, input.relativePath);
      const root = builder.add({
        ordinalPath: [0],
        kind: 'document',
        ...(title === undefined ? {} : { title }),
        metadata: { pages: pageCount, textNormalizationVersion: PDF_LIMITS.normalizationVersion },
      });

      let pagesWithText = 0;
      for (let number = 1; number <= pageCount; number += 1) {
        const emitted = await readPage(document, number, builder, root.id, warnings);
        if (emitted) pagesWithText += 1;
      }

      // Every page image and no text at all is a scanned document, which is out of scope and
      // says so, rather than producing an artifact with nothing in it.
      if (pagesWithText === 0 && pageCount > 0) {
        throw new LoreError(
          'LORE_E_UNSUPPORTED_FORMAT',
          `${input.displayPath} has no text layer on any of its ${pageCount} pages.`,
          {
            remediation:
              'This looks like a scanned document. Optical character recognition is out of scope for v0.1, so run OCR yourself and add the result, or exclude the file in .loreignore.',
            path: input.displayPath,
          },
        );
      }
      if (pagesWithText < pageCount) {
        warnings.push({
          code: 'pdf-pages-without-text',
          message: `${pageCount - pagesWithText} of ${pageCount} pages have no text layer and contributed nothing. Optical character recognition is out of scope for v0.1.`,
          line: 1,
        });
      }

      return {
        artifact: buildArtifact(input, pdfParser, {
          ...(title === undefined ? {} : { title }),
          metadata: { pages: pageCount },
        }),
        nodes: builder.nodes as LoreNode[],
        warnings,
      };
    } finally {
      // Always, including on the throws above: pdfjs holds worker state per document and a
      // build parses many of them. `destroy` lives on the loading task rather than on the
      // document, which is why the task is kept rather than discarded after `await`.
      await task.destroy();
    }
  },
};

/** The shape of pdfjs we actually use, so the import stays behind one narrow surface. */
interface PdfDocument {
  readonly numPages: number;
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: readonly { str?: string; hasEOL?: boolean }[] }>;
  }>;
  getMetadata(): Promise<{ info?: { Title?: unknown } }>;
}

interface LoadingTask {
  destroy(): Promise<void>;
}

async function open(input: ParseInput): Promise<{ document: PdfDocument; task: LoadingTask }> {
  const { getDocument, PasswordException } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let task: LoadingTask | null = null;
  try {
    const loading = getDocument({
      // Copied because pdfjs transfers the buffer to its worker and leaves the caller's view
      // detached, and the same bytes are hashed and cached by the build around us.
      data: new Uint8Array(input.bytes),
      // Section 20.9. Each of these is a way a document could otherwise reach outside
      // itself: fetching a font from the system or the network, or running the form
      // JavaScript an XFA document carries.
      //
      // There is deliberately no `isEvalSupported: false` here. That option and every
      // reference to it were removed in pdfjs 6, which no longer evaluates anything, so
      // passing it would be reassuring rather than true. Checked against 6.2.108.
      useSystemFonts: false,
      disableFontFace: true,
      enableXfa: false,
      // One bad object should not end the document. Damaged pages are reported per page
      // below, which is section 24.4's visible warning rather than silent loss.
      stopAtErrors: false,
      // pdfjs writes its own warnings to the console, including one about the canvas package
      // we deliberately removed. A parser does not own the process's output.
      verbosity: 0,
    });
    task = loading as unknown as LoadingTask;
    return { document: (await loading.promise) as unknown as PdfDocument, task };
  } catch (cause) {
    // The task exists even when the promise rejected, and it owns the worker.
    await task?.destroy().catch(() => undefined);
    if (cause instanceof PasswordException) {
      throw new LoreError(
        'LORE_E_UNSUPPORTED_FORMAT',
        `${input.displayPath} is password-protected.`,
        {
          remediation:
            'Remove the password and rebuild, or exclude the file in .loreignore. Lorepack never prompts for a credential during a build.',
          path: input.displayPath,
          cause,
        },
      );
    }
    throw new LoreError('LORE_E_PARSE_FAILED', `${input.displayPath} could not be read as a PDF.`, {
      remediation:
        'The file may be truncated or corrupt. Open it in a reader to confirm, or exclude it in .loreignore.',
      path: input.displayPath,
      cause,
    });
  }
}

/** True when the page contributed text. */
async function readPage(
  document: PdfDocument,
  number: number,
  builder: NodeBuilder,
  parentId: string,
  warnings: ParserWarning[],
): Promise<boolean> {
  let raw: string;
  try {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    raw = content.items
      .map((item) => (item.str ?? '') + (item.hasEOL === true ? '\n' : ''))
      .join('');
  } catch (cause) {
    // One damaged page does not fail a document. Section 24.4: visible warning, not silent
    // quality loss, and not a build that dies on page 400 of 600.
    warnings.push({
      code: 'pdf-page-unreadable',
      message: `Page ${number} could not be read and contributed nothing: ${
        cause instanceof Error ? cause.message.split('\n')[0] : String(cause)
      }`,
      line: number,
    });
    return false;
  }

  const paragraphs = normalizePageText(raw);
  if (paragraphs.length === 0) return false;

  // One section per page. A PDF has pages, not headings, and the locator says `page` because
  // that is the only coordinate the document actually has.
  const section = builder.add({
    ordinalPath: [0, number],
    kind: 'section',
    parentId,
    title: `Page ${number}`,
    metadata: { page: number },
  });

  for (const [index, text] of paragraphs.entries()) {
    builder.add({
      ordinalPath: [0, number, index + 1],
      kind: 'paragraph',
      parentId: section.id,
      text,
      headingPath: [`Page ${number}`],
      metadata: { page: number },
    });
  }
  return true;
}

/** The document's declared title, then the filename. Never the first line of text. */
async function titleFor(document: PdfDocument, relativePath: string): Promise<string | undefined> {
  try {
    const metadata = await document.getMetadata();
    const declared = metadata.info?.Title;
    if (typeof declared === 'string' && declared.trim() !== '') return declared.trim();
  } catch {
    // Metadata is optional and a missing dictionary is not a defect.
  }
  const filename = relativePath.split('/').at(-1) ?? relativePath;
  const withoutExtension = filename.replace(/\.[^.]+$/, '');
  return withoutExtension === '' ? undefined : withoutExtension;
}
