import { hashBytes, LoreError, type ParseInput } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import { markdownParser } from '../src/markdown/parser.js';

function parse(markdown: string, relativePath = 'docs/a.md') {
  const bytes = new TextEncoder().encode(markdown);
  const input: ParseInput = {
    artifactId: `src:${relativePath}`,
    sourceId: 'src',
    relativePath,
    displayPath: relativePath,
    mediaType: 'text/markdown',
    byteSize: bytes.byteLength,
    contentHash: hashBytes(bytes),
    bytes,
  };
  return markdownParser.parse(input);
}

const sections = (result: ReturnType<typeof parse>) =>
  result.nodes.filter((node) => node.kind === 'section');

describe('hierarchy', () => {
  it('nests headings and records the path to each one', () => {
    const result = parse('# Top\n\nintro\n\n## Middle\n\nbody\n\n### Deep\n\nleaf\n');
    const titles = sections(result).map((node) => node.title);
    expect(titles).toEqual(['Top', 'Middle', 'Deep']);

    const deep = sections(result).find((node) => node.title === 'Deep');
    expect(deep?.locator.headingPath).toEqual(['Top', 'Middle']);
  });

  it('attaches content to the section it appears under', () => {
    const result = parse('# Top\n\nunder top\n\n## Middle\n\nunder middle\n');
    const paragraphs = result.nodes.filter((node) => node.kind === 'paragraph');
    expect(paragraphs[0]?.locator.headingPath).toEqual(['Top']);
    expect(paragraphs[1]?.locator.headingPath).toEqual(['Top', 'Middle']);
  });

  it('treats a level jump as nesting rather than inventing a missing level', () => {
    // h1 straight to h3 is legal and common. Inventing an empty h2 would invent structure
    // the author did not write.
    const result = parse('# One\n\n### Three\n\nbody\n');
    const three = sections(result).find((node) => node.title === 'Three');
    expect(three?.locator.headingPath).toEqual(['One']);
  });

  it('closes a deeper section when a shallower heading follows', () => {
    const result = parse('# A\n\n## B\n\n### C\n\n## D\n\nbody\n');
    const d = sections(result).find((node) => node.title === 'D');
    expect(d?.locator.headingPath).toEqual(['A']);
  });

  it('handles a document with no headings at all', () => {
    const result = parse('just a paragraph\n\nand another\n');
    expect(sections(result)).toHaveLength(0);
    expect(result.nodes.filter((node) => node.kind === 'paragraph')).toHaveLength(2);
    expect(result.nodes[0]?.kind).toBe('document');
  });

  it('gives every node a parent except the document root', () => {
    const result = parse('# A\n\ntext\n\n## B\n\nmore\n');
    const roots = result.nodes.filter((node) => node.parentId === undefined);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.kind).toBe('document');
  });

  it('keeps duplicate heading titles distinct by id', () => {
    const result = parse('## Same\n\na\n\n## Same\n\nb\n');
    const ids = sections(result).map((node) => node.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('content kinds', () => {
  it('preserves code block text byte for byte, including indentation', () => {
    const code = 'function main() {\n    const x = 1;\n        return x;\n}';
    const result = parse(`# Code\n\n\`\`\`ts\n${code}\n\`\`\`\n`);
    const node = result.nodes.find((n) => n.kind === 'code');
    expect(node?.text).toBe(code);
    expect(node?.metadata.language).toBe('ts');
  });

  it('records lists and tables as their own kinds', () => {
    const result = parse('- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(result.nodes.some((node) => node.kind === 'list')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'table')).toBe(true);
  });

  it('keeps link text but never emits raw html', () => {
    const result = parse('See [the docs](https://example.com) and <b>bold</b>.\n');
    const text = result.nodes.find((node) => node.kind === 'paragraph')?.text ?? '';
    expect(text).toContain('the docs');
    expect(text).not.toContain('<b>');
    expect(text).not.toContain('https://example.com');
  });

  it('reads a fenced block containing markdown as code, not as structure', () => {
    const result = parse('```\n# Not a heading\n```\n');
    expect(sections(result)).toHaveLength(0);
    expect(result.nodes.find((node) => node.kind === 'code')?.text).toBe('# Not a heading');
  });
});

describe('locators', () => {
  it('records line ranges that point at the original file', () => {
    const result = parse('# Title\n\nfirst\n\n## Second\n\nlater\n');
    const second = sections(result).find((node) => node.title === 'Second');
    expect(second?.locator.lineStart).toBe(5);
  });

  it('gives every node a locator naming its artifact and path', () => {
    const result = parse('# A\n\nbody\n', 'deep/nested/file.md');
    for (const node of result.nodes) {
      expect(node.locator.artifactId).toBe('src:deep/nested/file.md');
      expect(node.locator.relativePath).toBe('deep/nested/file.md');
      expect(node.locator.lineStart).toBeGreaterThan(0);
    }
  });

  it('reports the same line numbers for CRLF input as for LF', () => {
    const lf = parse('# A\n\nbody\n\n## B\n\nmore\n');
    const crlf = parse('# A\r\n\r\nbody\r\n\r\n## B\r\n\r\nmore\r\n');
    expect(crlf.nodes.map((node) => node.locator.lineStart)).toEqual(
      lf.nodes.map((node) => node.locator.lineStart),
    );
  });
});

describe('frontmatter', () => {
  it('parses it into metadata and prefers its title', () => {
    const result = parse('---\ntitle: Declared\nauthor: Someone\n---\n\n# Written\n\nbody\n');
    expect(result.artifact.title).toBe('Declared');
    expect(result.artifact.metadata.author).toBe('Someone');
  });

  it('warns and continues when it is malformed, rather than failing the artifact', () => {
    const result = parse('---\ntitle: [unclosed\n---\n\n# Body\n\ntext\n');
    expect(result.warnings.some((warning) => warning.code === 'frontmatter-invalid')).toBe(true);
    expect(result.artifact.title).toBe('Body');
    expect(result.nodes.length).toBeGreaterThan(1);
  });

  it('ignores frontmatter that is not a mapping', () => {
    const result = parse('---\n- one\n- two\n---\n\n# Body\n');
    expect(result.warnings.some((w) => w.code === 'frontmatter-not-a-mapping')).toBe(true);
  });

  it('never lets frontmatter set authority or status, which are user-declared rules', () => {
    // Architecture section 12.7: rules are resolved after parsing. A parser inferring
    // authority from content would be inventing truth.
    const result = parse('---\nauthority: 100\nstatus: archived\n---\n\n# Body\n');
    expect(result.artifact.authority).toBe(50);
    expect(result.artifact.status).toBe('active');
  });
});

describe('title resolution', () => {
  it.each([
    ['---\ntitle: From frontmatter\n---\n\n# From heading\n', 'From frontmatter'],
    ['# From heading\n\nbody\n', 'From heading'],
    ['just text, no heading\n', 'a'],
  ])('resolves in the documented order', (markdown, expected) => {
    expect(parse(markdown).artifact.title).toBe(expected);
  });
});

describe('determinism', () => {
  it('produces identical ids and hashes on repeated parses', () => {
    const markdown = '# A\n\nbody\n\n## B\n\n- one\n- two\n';
    const first = parse(markdown);
    const second = parse(markdown);
    expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
    expect(second.nodes.map((n) => n.revisionHash)).toEqual(first.nodes.map((n) => n.revisionHash));
  });

  it('keeps ids stable for sections before an edit', () => {
    // Editing one section must not renumber the rest, or every build diff would show the
    // whole document as changed.
    const before = parse('# A\n\nfirst\n\n## B\n\nsecond\n\n## C\n\nthird\n');
    const after = parse('# A\n\nfirst\n\n## B\n\nEDITED\n\n## C\n\nthird\n');

    const idsBefore = before.nodes.map((n) => n.id);
    const idsAfter = after.nodes.map((n) => n.id);
    expect(idsAfter).toEqual(idsBefore);

    const changed = before.nodes.filter(
      (node, index) => node.revisionHash !== after.nodes[index]?.revisionHash,
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]?.text).toBe('second');
  });

  it('gives CRLF and LF input identical node hashes', () => {
    const lf = parse('# A\n\nbody\n');
    const crlf = parse('# A\r\n\r\nbody\r\n');
    expect(crlf.nodes.map((n) => n.revisionHash)).toEqual(lf.nodes.map((n) => n.revisionHash));
  });
});

describe('encoding and edge cases', () => {
  it('strips a byte order mark', () => {
    const result = parse(`${String.fromCharCode(0xfeff)}# Title\n\nbody\n`);
    expect(result.artifact.title).toBe('Title');
  });

  it('refuses a file that is not valid UTF-8', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00]);
    expect(() =>
      markdownParser.parse({
        artifactId: 'src:a.md',
        sourceId: 'src',
        relativePath: 'a.md',
        displayPath: 'a.md',
        mediaType: 'text/markdown',
        byteSize: bytes.byteLength,
        contentHash: hashBytes(bytes),
        bytes,
      }),
    ).toThrowError(LoreError);
  });

  it('handles an empty document without crashing', () => {
    const result = parse('');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.kind).toBe('document');
  });

  it('warns about an empty heading', () => {
    const result = parse('## \n\nbody\n');
    expect(result.warnings.some((warning) => warning.code === 'empty-heading')).toBe(true);
  });

  it('parses a large document in reasonable time', () => {
    const large = Array.from({ length: 2000 }, (_, i) => `## Section ${i}\n\nBody ${i}\n`).join(
      '\n',
    );
    const started = performance.now();
    const result = parse(large);
    expect(result.nodes.length).toBeGreaterThan(4000);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('supports', () => {
  it.each(['a.md', 'a.markdown', 'a.mdx', 'DEEP/B.MD'])('claims %s', (path) => {
    expect(markdownParser.supports({ mediaType: 'text/plain', relativePath: path })).toBe(true);
  });

  it.each(['a.txt', 'a.ts', 'a.pdf'])('does not claim %s', (path) => {
    expect(markdownParser.supports({ mediaType: 'text/plain', relativePath: path })).toBe(false);
  });
});
