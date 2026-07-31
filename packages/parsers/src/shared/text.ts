import { LoreError } from '@lorepack/core';

/**
 * Decoding is strict on purpose.
 *
 * Guessing an encoding produces plausible nonsense, and nonsense inside a build is worse
 * than a skipped file with a warning. A file that is not valid UTF-8, or that contains a
 * NUL byte, is treated as binary and excluded.
 */

/** U+FEFF, built from its codepoint so this file holds no invisible characters. */
export const BOM = String.fromCharCode(0xfeff);

export function looksBinary(bytes: Uint8Array): boolean {
  // A NUL byte in the first few kilobytes is the classic binary signal, and it is the one
  // that matters here: a text file legitimately never contains one.
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * UTF-16 is worth naming specifically. It is common on Windows, it contains NUL bytes so
 * it trips the binary check first, and "appears to be binary" sends the user looking for
 * the wrong problem. The fix is a conversion, so say so.
 */
export function looksUtf16(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const [first, second] = [bytes[0], bytes[1]];
  return (first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff);
}

export function decodeUtf8Strict(bytes: Uint8Array, displayPath: string): string {
  if (looksUtf16(bytes)) {
    throw new LoreError('LORE_E_UNSUPPORTED_FORMAT', `${displayPath} appears to be UTF-16.`, {
      remediation:
        'Convert it to UTF-8, for example `iconv -f UTF-16 -t UTF-8`. Lorepack does not guess encodings, because guessing produces plausible nonsense rather than an obvious failure.',
      path: displayPath,
    });
  }
  if (looksBinary(bytes)) {
    throw new LoreError('LORE_E_UNSUPPORTED_FORMAT', `${displayPath} appears to be binary.`, {
      remediation: 'Exclude it in .loreignore, or convert it to UTF-8 text.',
      path: displayPath,
    });
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.startsWith(BOM) ? text.slice(BOM.length) : text;
  } catch (cause) {
    throw new LoreError('LORE_E_UNSUPPORTED_FORMAT', `${displayPath} is not valid UTF-8.`, {
      remediation:
        'Convert the file to UTF-8, or exclude it in .loreignore. Lorepack does not guess encodings, because guessing produces plausible nonsense rather than an obvious failure.',
      path: displayPath,
      cause,
    });
  }
}

/**
 * Internal line endings are always LF (architecture section 12.5). Original line numbers
 * stay recoverable because normalization only ever removes carriage returns, which never
 * changes how many lines there are.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/** One-based line number for a character offset. */
export function lineAt(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((offsets[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** Collapses runs of blank lines but never touches content, used for paragraph splitting. */
export function splitParagraphs(text: string): Array<{ text: string; line: number }> {
  const lines = text.split('\n');
  const paragraphs: Array<{ text: string; line: number }> = [];
  let current: string[] = [];
  let startLine = 1;

  const flush = (): void => {
    if (current.length === 0) return;
    const joined = current.join('\n').trim();
    if (joined !== '') paragraphs.push({ text: joined, line: startLine });
    current = [];
  };

  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      flush();
      startLine = index + 2;
      continue;
    }
    if (current.length === 0) startLine = index + 1;
    current.push(line);
  }
  flush();
  return paragraphs;
}
