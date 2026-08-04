import { LoreError, looksBinary, type ParserWarning } from '@lorepack/core';
import { BOM } from '../shared/text.js';

/**
 * HTML is the one format that declares its own encoding, so it is the one place decoding is
 * not simply strict UTF-8.
 *
 * Everywhere else in Lorepack a file that is not UTF-8 is excluded, because guessing an
 * encoding produces plausible nonsense. HTML is different in kind rather than in degree: a
 * page carrying `<meta charset="windows-1252">` is not ambiguous, it is *labelled*, and
 * honouring a label is not guessing. A legacy documentation export is exactly the file
 * someone points Lorepack at, and refusing it would be refusing a document that says what it
 * is.
 *
 * The boundary is drawn deliberately:
 *
 * - **A declared encoding is honoured** when the platform can decode it.
 * - **An undeclared file is UTF-8**, per the HTML spec's default, and is decoded strictly.
 * - **Nothing is sniffed.** There is no statistical detection here. Without a declaration
 *   there is no second guess.
 */

/** Enough of the head to find a charset declaration. The spec says 1024 bytes; so do we. */
const DECLARATION_WINDOW = 1024;

/**
 * Labels that mean UTF-8 by another name, so a declaration does not send us down the legacy
 * path for the encoding we were going to use anyway.
 */
const UTF8_LABELS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8', 'ascii', 'us-ascii']);

export function decodeHtml(
  bytes: Uint8Array,
  displayPath: string,
  warnings: ParserWarning[],
): string {
  // A NUL byte means this is not a text document whatever it claims, and the UTF-16 check
  // that guards other formats does not apply: a UTF-16 page is legal and declares itself.
  if (looksBinary(bytes)) {
    throw new LoreError('LORE_E_UNSUPPORTED_FORMAT', `${displayPath} appears to be binary.`, {
      remediation: 'Exclude it in .loreignore, or convert it to UTF-8 text.',
      path: displayPath,
    });
  }

  const declared = declaredEncoding(bytes);
  if (declared === null || UTF8_LABELS.has(declared)) return strictUtf8(bytes, displayPath);

  try {
    // `fatal` is deliberately off for a declared legacy encoding. Single-byte encodings map
    // every byte to some character, so there is nothing to be strict about; refusing on a
    // replacement character would reject a page over one bad byte in a footer.
    const text = new TextDecoder(declared).decode(bytes);
    warnings.push({
      code: 'html-declared-encoding',
      message: `Decoded as ${declared}, which this page declares. Text is stored as UTF-8.`,
      line: 1,
    });
    return strip(text);
  } catch {
    // An unknown label is not a reason to fail: the page may still be UTF-8, and saying so
    // is more useful than refusing a document that mislabelled itself.
    warnings.push({
      code: 'html-unknown-encoding',
      message: `This page declares the encoding "${declared}", which this platform cannot decode. It was read as UTF-8 instead.`,
      line: 1,
    });
    return strictUtf8(bytes, displayPath);
  }
}

function strictUtf8(bytes: Uint8Array, displayPath: string): string {
  try {
    return strip(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new LoreError('LORE_E_UNSUPPORTED_FORMAT', `${displayPath} is not valid UTF-8.`, {
      remediation:
        'Declare the encoding with <meta charset>, convert the file to UTF-8, or exclude it in .loreignore. Lorepack honours a declared encoding but never guesses one.',
      path: displayPath,
      cause,
    });
  }
}

function strip(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * The declared label, or null.
 *
 * Read from the raw bytes as Latin-1 rather than from decoded text, because decoding is the
 * thing this is deciding. Only the first kilobyte is examined, which is where the spec says
 * a declaration must appear and which keeps this bounded on a large document.
 */
export function declaredEncoding(bytes: Uint8Array): string | null {
  const head = Array.from(bytes.slice(0, DECLARATION_WINDOW), (byte) =>
    String.fromCharCode(byte),
  ).join('');

  const charset = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head);
  if (charset?.[1] !== undefined) return charset[1].toLowerCase();

  const httpEquiv = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_:.-]+)/i.exec(head);
  return httpEquiv?.[1]?.toLowerCase() ?? null;
}
