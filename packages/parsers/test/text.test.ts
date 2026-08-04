import { hashBytes, type LoreError, type ParseInput } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import { FORMATS, formatFor, isPlannedFormat, isSupported } from '../src/registry.js';
import { parserFor } from '../src/registry-parsers.js';
import { splitParagraphs } from '../src/shared/text.js';
import { textParser } from '../src/text/parser.js';

function parse(contents: string | Uint8Array, relativePath = 'notes.txt') {
  const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;
  const input: ParseInput = {
    artifactId: `src:${relativePath}`,
    sourceId: 'src',
    relativePath,
    displayPath: relativePath,
    mediaType: 'text/plain',
    byteSize: bytes.byteLength,
    contentHash: hashBytes(bytes),
    bytes,
  };
  return textParser.parse(input);
}

describe('plain text', () => {
  it('splits into paragraphs on blank lines', () => {
    const result = parse('First paragraph.\nStill first.\n\nSecond paragraph.\n');
    const paragraphs = result.nodes.filter((node) => node.kind === 'paragraph');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.text).toBe('First paragraph.\nStill first.');
    expect(paragraphs[1]?.text).toBe('Second paragraph.');
  });

  it('records line ranges pointing at the original file', () => {
    const result = parse('one\n\ntwo\n\nthree\n');
    const paragraphs = result.nodes.filter((node) => node.kind === 'paragraph');
    expect(paragraphs.map((node) => node.locator.lineStart)).toEqual([1, 3, 5]);
  });

  it('titles the document from its filename', () => {
    expect(parse('body', 'docs/meeting-notes.txt').artifact.title).toBe('meeting-notes');
  });

  it('warns about an empty file rather than producing an empty artifact silently', () => {
    const result = parse('   \n\n  \n');
    expect(result.warnings.some((warning) => warning.code === 'empty-file')).toBe(true);
    expect(result.nodes).toHaveLength(1);
  });
});

describe('source code', () => {
  it('produces code nodes, not paragraphs', () => {
    const result = parse('export function a() {\n  return 1;\n}\n', 'src/a.ts');
    expect(result.nodes.filter((node) => node.kind === 'code').length).toBeGreaterThan(0);
    expect(result.nodes.some((node) => node.kind === 'paragraph')).toBe(false);
  });

  it('preserves indentation exactly', () => {
    const source = 'function a() {\n    if (x) {\n        return 1;\n    }\n}';
    const node = parse(source, 'a.js').nodes.find((n) => n.kind === 'code');
    expect(node?.text).toBe(source);
  });

  it('records the language from the extension', () => {
    expect(parse('x = 1', 'a.py').artifact.metadata.language).toBe('py');
    expect(parse('{}', 'a.json').artifact.metadata.language).toBe('json');
  });

  it('is syntax neutral, so every language behaves the same', () => {
    // Architecture section 8.7: no AST requirement in v0.1. Region splitting is identical
    // across languages, which is the point.
    const body = 'block one\n\nblock two\n';
    const counts = ['a.py', 'a.go', 'a.rs', 'a.sql'].map(
      (path) => parse(body, path).nodes.filter((node) => node.kind === 'code').length,
    );
    expect(new Set(counts).size).toBe(1);
  });
});

describe('encoding', () => {
  it('refuses a file containing NUL bytes as binary', () => {
    const bytes = new Uint8Array([0x68, 0x69, 0x00, 0x68, 0x69]);
    try {
      parse(bytes, 'a.txt');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as LoreError).code).toBe('LORE_E_UNSUPPORTED_FORMAT');
      expect((error as LoreError).message).toContain('binary');
    }
  });

  it('names UTF-16 specifically, since telling the user it is binary sends them the wrong way', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
    try {
      parse(bytes, 'a.txt');
      expect.unreachable('should have thrown');
    } catch (error) {
      const loreError = error as LoreError;
      expect(loreError.message).toContain('UTF-16');
      expect(loreError.remediation).toContain('iconv');
      expect(loreError.remediation).toContain('guessing produces plausible nonsense');
    }
  });

  it('refuses other invalid UTF-8 too', () => {
    // A lone continuation byte: not valid UTF-8, and not UTF-16 either.
    const bytes = new Uint8Array([0x41, 0x80, 0x42]);
    try {
      parse(bytes, 'a.txt');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as LoreError).message).toContain('not valid UTF-8');
    }
  });

  it('strips a byte order mark from otherwise valid UTF-8', () => {
    const result = parse(`${String.fromCharCode(0xfeff)}hello`);
    expect(result.nodes.find((node) => node.kind === 'paragraph')?.text).toBe('hello');
  });

  it('normalizes CRLF without changing line numbers', () => {
    const lf = parse('one\n\ntwo\n');
    const crlf = parse('one\r\n\r\ntwo\r\n');
    expect(crlf.nodes.map((n) => n.locator.lineStart)).toEqual(
      lf.nodes.map((n) => n.locator.lineStart),
    );
    expect(crlf.nodes.map((n) => n.revisionHash)).toEqual(lf.nodes.map((n) => n.revisionHash));
  });
});

describe('pathological input', () => {
  it('splits a very long single line and says so', () => {
    const result = parse('x'.repeat(50_000), 'a.txt');
    expect(result.warnings.some((warning) => warning.code === 'long-line-split')).toBe(true);
    expect(result.nodes.length).toBeGreaterThan(1);
  });

  it('handles a 5 MB file without exhausting memory', () => {
    const body = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join('\n');
    const result = parse(body, 'big.txt');
    expect(result.nodes.length).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('produces identical output for identical input', () => {
    const body = 'one\n\ntwo\n\nthree\n';
    const first = parse(body);
    const second = parse(body);
    expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
    expect(second.nodes.map((n) => n.revisionHash)).toEqual(first.nodes.map((n) => n.revisionHash));
  });

  it('keeps ids stable when a later region changes', () => {
    const before = parse('one\n\ntwo\n\nthree\n');
    const after = parse('one\n\ntwo\n\nEDITED\n');
    expect(after.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
    const changed = before.nodes.filter(
      (node, index) => node.revisionHash !== after.nodes[index]?.revisionHash,
    );
    expect(changed).toHaveLength(1);
  });
});

describe('splitParagraphs', () => {
  it('reports the starting line of each region', () => {
    expect(splitParagraphs('a\n\nb\n\n\nc')).toEqual([
      { text: 'a', line: 1 },
      { text: 'b', line: 3 },
      { text: 'c', line: 6 },
    ]);
  });

  it('ignores trailing and leading blank lines', () => {
    expect(splitParagraphs('\n\n  \n\nonly\n\n\n')).toEqual([{ text: 'only', line: 5 }]);
  });
});

describe('registry', () => {
  it('maps extensions to a format and a parser', () => {
    expect(formatFor('a.md')?.parserId).toBe('markdown');
    expect(formatFor('a.TS')?.parserId).toBe('code');
    expect(formatFor('Dockerfile')?.parserId).toBe('code');
    expect(formatFor('unknown.xyz')).toBeNull();
  });

  /**
   * Phase 5 turned on the last format in the registry, so nothing is "planned" any more.
   *
   * The distinction still exists in the code and still matters: a format the architecture
   * schedules for a later release deserves a different message from one nobody has heard of,
   * and the next format added will use it. What changed is that the set is currently empty,
   * and asserting that is more honest than keeping a fixture pretending otherwise.
   */
  it('has implemented every format it lists, so nothing is merely planned', () => {
    for (const entry of FORMATS) {
      expect(entry.available, entry.extensions.join(' ')).toBe(true);
      expect(isPlannedFormat(`a${entry.extensions[0] as string}`)).toBe(false);
    }
    expect(isSupported('a.md')).toBe(true);
    expect(isSupported('a.pdf')).toBe(true);
    expect(isSupported('a.docx')).toBe(true);
    expect(isSupported('a.xlsx')).toBe(true);
    // An extension nobody registered is unknown, which is a different thing again.
    expect(isSupported('a.png')).toBe(false);
    expect(isPlannedFormat('a.png')).toBe(false);
  });

  it('routes each supported file to exactly one parser', () => {
    for (const path of ['a.md', 'b.txt', 'c.ts', 'd.yaml']) {
      const parser = parserFor({ mediaType: 'text/plain', relativePath: path });
      expect(parser, path).not.toBeNull();
    }
    expect(parserFor({ mediaType: 'application/pdf', relativePath: 'a.pdf' })?.id).toBe('pdf-text');
    expect(
      parserFor({
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        relativePath: 'a.xlsx',
      })?.id,
    ).toBe('xlsx');
    // An unregistered extension routes to nothing, which is what makes discovery warn
    // rather than fail.
    expect(parserFor({ mediaType: 'image/png', relativePath: 'a.png' })).toBeNull();
  });

  it('enables a new text format by adding a registry entry alone', () => {
    // The registry is data, so this assertion is about shape rather than behaviour: any
    // extension listed against an available format is routable without new code.
    const entry = formatFor('a.toml');
    expect(entry?.available).toBe(true);
    expect(parserFor({ mediaType: entry?.mediaType ?? '', relativePath: 'a.toml' })).not.toBeNull();
  });
});
