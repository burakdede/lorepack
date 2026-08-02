import { describe, expect, it } from 'vitest';
import {
  classifyBytes,
  TextClassifier,
  type UndecodableReason,
  undecodableMessage,
} from '../src/format/text-encoding.js';

/**
 * The rule that decides whether a file is text this project can read.
 *
 * It matters that the streaming and whole-buffer forms agree: fingerprinting uses the
 * stream while hashing, the parsers use the buffer, and a disagreement between them is the
 * shape of #165, where a file the parsers refused was still counted as part of the build.
 */

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Feeds the same bytes through the streaming classifier, one chunk at a time. */
function streamed(input: Uint8Array, chunkSize: number): UndecodableReason | null {
  const classifier = new TextClassifier();
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    classifier.update(input.subarray(offset, offset + chunkSize));
  }
  return classifier.finish();
}

describe('classifying bytes', () => {
  it('accepts ordinary UTF-8 text', () => {
    expect(classifyBytes(utf8('# Title\n\nBody with an accent: café.\n'))).toBeNull();
  });

  it('accepts an empty file', () => {
    expect(classifyBytes(new Uint8Array())).toBeNull();
  });

  it('rejects a NUL byte as binary', () => {
    expect(classifyBytes(bytes(0x68, 0x00, 0x69))).toBe('binary');
  });

  it('names UTF-16 rather than calling it binary, because the fix differs', () => {
    expect(classifyBytes(bytes(0xff, 0xfe, 0x68, 0x00))).toBe('utf-16');
    expect(classifyBytes(bytes(0xfe, 0xff, 0x00, 0x68))).toBe('utf-16');
  });

  it('rejects bytes that are not valid UTF-8', () => {
    // Latin-1 "café": 0xE9 is a valid lead byte with no continuation, so it is not UTF-8.
    expect(classifyBytes(bytes(0x63, 0x61, 0x66, 0xe9, 0x0a))).toBe('invalid-utf-8');
  });

  it('rejects a file that ends mid-sequence', () => {
    // The first two bytes of a three-byte sequence, and then nothing.
    expect(classifyBytes(bytes(0xe2, 0x82))).toBe('invalid-utf-8');
  });

  it('finds a NUL byte far into the file, not only in a leading window', () => {
    const late = new Uint8Array(9000);
    late.fill(0x61);
    late[8500] = 0x00;
    // A NUL is valid UTF-8, so a decoder accepts it. Only the explicit scan catches this,
    // and a leading window would index a file that turns binary partway through.
    expect(classifyBytes(late)).toBe('binary');
  });
});

describe('the streaming form', () => {
  const cases: ReadonlyArray<readonly [string, Uint8Array]> = [
    ['plain text', utf8('hello, world\n')],
    ['multi-byte text', utf8('emoji: \u{1F680}\naccent: café\n')],
    ['binary', bytes(0x68, 0x00, 0x69)],
    ['utf-16', bytes(0xff, 0xfe, 0x68, 0x00)],
    ['invalid utf-8', bytes(0x63, 0x61, 0x66, 0xe9, 0x0a)],
  ];

  for (const [name, input] of cases) {
    it(`agrees with the whole-buffer form on ${name}, at every chunk size`, () => {
      const expected = classifyBytes(input);
      // Size 1 splits multi-byte sequences across chunks, which is the case a naive
      // implementation gets wrong by reporting valid text as invalid.
      for (const chunkSize of [1, 2, 3, 7, input.length || 1]) {
        expect(streamed(input, chunkSize), `chunk size ${chunkSize}`).toBe(expected);
      }
    });
  }
});

describe('the message a user reads', () => {
  it('names the file and the fix, not the detection', () => {
    expect(undecodableMessage('notes/a.md', 'utf-16')).toContain('iconv');
    expect(undecodableMessage('notes/a.md', 'binary')).toContain('notes/a.md');
    expect(undecodableMessage('notes/a.md', 'invalid-utf-8')).toContain('.loreignore');
  });

  it('says the file was not indexed, in every case', () => {
    for (const reason of ['binary', 'utf-16', 'invalid-utf-8'] as const) {
      expect(undecodableMessage('a.md', reason)).toContain('not indexed');
    }
  });
});
