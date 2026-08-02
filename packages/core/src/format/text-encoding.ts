/**
 * Deciding whether a byte stream is text this project can read, in one place.
 *
 * Two stages need the same answer and used to answer it separately. The parsers refuse to
 * decode a file that is binary, UTF-16, or invalid UTF-8, because guessing an encoding
 * produces plausible nonsense and nonsense inside a build is worse than a named exclusion.
 * Fingerprinting has to reach the same verdict, because it is the stage that decides which
 * files a build contains: a file excluded later but counted here leaves the project
 * permanently dirty, telling the user to run a build that then reports no changes.
 *
 * So the rule lives here, and both stages apply it to the same bytes.
 */

/** Why a file is not indexable text. `null` means it is. */
export type UndecodableReason = 'binary' | 'utf-16' | 'invalid-utf-8';

/**
 * The classic binary signal: text legitimately never contains a NUL byte.
 *
 * Scanned over the whole file rather than a leading window. A NUL is valid UTF-8 (U+0000),
 * so a decoder accepts it happily, and a window means a file that is binary from byte 8193
 * onward is indexed as text. The scan is one native pass and costs nothing next to hashing.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

/**
 * UTF-16 is worth naming separately. It is common on Windows, it contains NUL bytes so it
 * trips the binary check first, and "appears to be binary" sends the user looking for the
 * wrong problem. The fix is a conversion, so say so.
 */
export function looksUtf16(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const [first, second] = [bytes[0], bytes[1]];
  return (first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff);
}

export function classifyBytes(bytes: Uint8Array): UndecodableReason | null {
  const classifier = new TextClassifier();
  classifier.update(bytes);
  return classifier.finish();
}

/**
 * The same verdict over a stream, so fingerprinting can classify a file in the pass it
 * already makes to hash it. No second read, and no separate rule to drift.
 */
export class TextClassifier {
  /** Only the first two bytes are needed, for the UTF-16 byte order mark. */
  #opening: number[] = [];
  #decoder = new TextDecoder('utf-8', { fatal: true });
  #binary = false;
  #invalidUtf8 = false;

  update(chunk: Uint8Array): void {
    for (let i = 0; this.#opening.length < 2 && i < chunk.length; i += 1) {
      this.#opening.push(chunk[i] as number);
    }
    if (chunk.includes(0)) this.#binary = true;
    if (this.#invalidUtf8) return;
    try {
      this.#decoder.decode(chunk, { stream: true });
    } catch {
      this.#invalidUtf8 = true;
    }
  }

  finish(): UndecodableReason | null {
    // Order matters. UTF-16 contains NUL bytes, so it would otherwise be reported as binary,
    // and "appears to be binary" sends the user looking for the wrong problem.
    if (looksUtf16(Uint8Array.from(this.#opening))) return 'utf-16';
    if (this.#binary) return 'binary';
    if (this.#invalidUtf8) return 'invalid-utf-8';
    try {
      // Flushes the decoder: a file ending mid-sequence is invalid, not merely truncated.
      this.#decoder.decode(new Uint8Array(), { stream: false });
    } catch {
      return 'invalid-utf-8';
    }
    return null;
  }
}

/** The sentence a user reads, in the words of the fix rather than of the detection. */
export function undecodableMessage(displayPath: string, reason: UndecodableReason): string {
  switch (reason) {
    case 'utf-16':
      return `${displayPath} appears to be UTF-16, so it was not indexed. Convert it to UTF-8, for example \`iconv -f UTF-16 -t UTF-8\`.`;
    case 'binary':
      return `${displayPath} appears to be binary, so it was not indexed.`;
    case 'invalid-utf-8':
      return `${displayPath} is not valid UTF-8, so it was not indexed. Convert it to UTF-8, or exclude it in .loreignore.`;
  }
}
