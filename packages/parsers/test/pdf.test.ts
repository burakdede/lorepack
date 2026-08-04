import { hashBytes, LoreError, type ParsedArtifact, type ParseInput } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import { pdfParser } from '../src/pdf/parser.js';
import { normalizePageText, PDF_LIMITS } from '../src/pdf/text.js';
import { makeEncryptedPdf, makePdf, type PageSpec } from './support/make-pdf.js';

/**
 * The text-layer PDF parser.
 *
 * Two properties carry most of the weight, and both are about refusing rather than producing.
 * A scanned document must be refused with a message naming OCR, because an empty artifact
 * looks like a working one. And no heading may be inferred from font size, because a PDF has
 * no headings and inventing them would put structure in the build that is not in the document.
 */

function parse(pages: readonly PageSpec[], options: { title?: string } = {}) {
  return parseBytes(makePdf(pages, options));
}

function parseBytes(bytes: Uint8Array, relativePath = 'doc.pdf'): Promise<ParsedArtifact> {
  const input: ParseInput = {
    artifactId: `p:${relativePath}`,
    sourceId: 'p',
    relativePath,
    displayPath: relativePath,
    mediaType: 'application/pdf',
    byteSize: bytes.byteLength,
    contentHash: hashBytes(bytes),
    bytes,
  };
  return Promise.resolve(pdfParser.parse(input)) as Promise<ParsedArtifact>;
}

const textOf = (parsed: ParsedArtifact): string =>
  parsed.nodes
    .filter((node) => node.kind === 'paragraph')
    .map((node) => node.text)
    .join(' ');

describe('extraction', () => {
  it('reads text per page with a page locator on every node', async () => {
    const parsed = await parse([
      { lines: ['Release notes'] },
      { lines: ['Rolling back is a pointer change.'] },
    ]);

    expect(textOf(parsed)).toContain('Release notes');
    expect(textOf(parsed)).toContain('pointer change');

    const sections = parsed.nodes.filter((node) => node.kind === 'section');
    expect(sections.map((node) => node.title)).toEqual(['Page 1', 'Page 2']);
    for (const node of parsed.nodes.filter((n) => n.kind === 'paragraph')) {
      expect(node.metadata).toHaveProperty('page');
    }
  });

  /**
   * A PDF has pages, not headings. Section 4.4 asks for structure to be preserved rather than
   * invented, and font-size inference would invent a hierarchy the document does not contain.
   */
  it('uses the page as the only structure, never an inferred heading', async () => {
    const parsed = await parse([{ lines: ['BIG LOOKING TITLE', 'then some body text'] }]);
    const sections = parsed.nodes.filter((node) => node.kind === 'section');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe('Page 1');
    expect(
      parsed.nodes.every((node) => node.locator.headingPath?.[0] !== 'BIG LOOKING TITLE'),
    ).toBe(true);
  });

  it('takes the title from the document, then the filename, never the first line', async () => {
    expect((await parse([{ lines: ['First line'] }], { title: 'Declared' })).artifact.title).toBe(
      'Declared',
    );
    const undeclared = await parseBytes(makePdf([{ lines: ['First line'] }]), 'reports/q3.pdf');
    expect(undeclared.artifact.title).toBe('q3');
  });

  it('records the page count', async () => {
    const parsed = await parse([{ lines: ['a'] }, { lines: ['b'] }, { lines: ['c'] }]);
    expect(parsed.artifact.metadata).toMatchObject({ pages: 3 });
  });
});

describe('what is out of scope, and says so', () => {
  it('refuses a document whose pages carry no text at all', async () => {
    const failure = await parse([
      { lines: [], image: true },
      { lines: [], image: true },
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LoreError);
    const error = failure as LoreError;
    // The message has to name OCR. "No text found" would send someone hunting for a bug.
    expect(error.message).toContain('no text layer');
    expect(error.remediation).toContain('Optical character recognition is out of scope');
  });

  it('keeps a partly scanned document and warns about the pages that gave nothing', async () => {
    const parsed = await parse([{ lines: ['Real text here.'] }, { lines: [], image: true }]);

    expect(textOf(parsed)).toContain('Real text here.');
    const warning = parsed.warnings.find((one) => one.code === 'pdf-pages-without-text');
    expect(warning?.message).toContain('1 of 2 pages');
  });

  it('fails a password-protected document with an actionable message', async () => {
    const failure = await parseBytes(makeEncryptedPdf()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LoreError);
    const error = failure as LoreError;
    expect(error.message).toContain('password-protected');
    // Never prompting is the point: a build is not an interactive session, and a parser that
    // asked for a credential would hang CI rather than fail it.
    expect(error.remediation).toContain('never prompts');
  });
});

describe('malformed input, per section 20.9', () => {
  it('fails a truncated file with a typed error rather than crashing', async () => {
    const whole = makePdf([{ lines: ['Complete document'] }]);
    const failure = await parseBytes(whole.slice(0, Math.floor(whole.length / 3))).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(LoreError);
    expect((failure as LoreError).code).toMatch(/^LORE_E_/);
  });

  it('fails bytes that are not a PDF at all', async () => {
    const failure = await parseBytes(new TextEncoder().encode('this is just prose')).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LoreError);
  });

  it('does not hang or exhaust memory on a deeply nested document', async () => {
    // A pathological object graph. The property being pinned is that this returns, either
    // with an artifact or with a typed error, rather than running forever.
    const nested = `%PDF-1.4\n1 0 obj\n${'<< /A '.repeat(500)}1${' >>'.repeat(500)}\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`;
    const bytes = new Uint8Array(nested.length);
    for (let i = 0; i < nested.length; i += 1) bytes[i] = nested.charCodeAt(i) & 0xff;

    const outcome = await parseBytes(bytes).catch((error: unknown) => error);
    expect(outcome).toBeDefined();
  }, 30_000);
});

describe('text normalization, which is versioned policy', () => {
  it('expands ligatures so a word stays searchable', () => {
    // Typeset with an fl ligature, "workflow" would not match a query for "workflow".
    expect(normalizePageText('the workﬂow and the oﬃce')).toEqual(['the workflow and the office']);
  });

  it('joins a line-break hyphen without inserting a space, and keeps the hyphen', () => {
    // Nothing distinguishes a wrapped compound from a split word, and the two repairs
    // disagree. Keeping the hyphen preserves the page; removing it would fabricate a
    // spelling that appears in no document.
    expect(normalizePageText('a long-\nterm plan')).toEqual(['a long-term plan']);
    expect(normalizePageText('the depart-\nment head')).toEqual(['the depart-ment head']);
  });

  it('joins lines inside a paragraph and splits on a blank line', () => {
    expect(normalizePageText('one line\nwrapped here\n\nsecond paragraph')).toEqual([
      'one line wrapped here',
      'second paragraph',
    ]);
  });

  it('collapses the space runs a PDF uses to fake justification', () => {
    expect(normalizePageText('spaced     out    text')).toEqual(['spaced out text']);
  });
});

describe('the scale envelope', () => {
  it('warns beyond the documented page count without refusing the document', async () => {
    const pages = Array.from({ length: PDF_LIMITS.warnPages + 2 }, (_, index) => ({
      lines: [`Page ${index + 1} content`],
    }));
    const parsed = await parse(pages);

    expect(parsed.warnings.map((one) => one.code)).toContain('pdf-large-document');
    expect(textOf(parsed)).toContain('Page 1 content');
  }, 120_000);
});

describe('determinism', () => {
  it('produces identical output on a second parse', async () => {
    const bytes = makePdf([{ lines: ['Stable text'] }, { lines: ['More text'] }]);
    const first = await parseBytes(bytes);
    const second = await parseBytes(bytes);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('starts every artifact neutral, leaving status and authority to the rule stage', async () => {
    const parsed = await parse([{ lines: ['Anything'] }]);
    expect(parsed.artifact.status).toBe('active');
    expect(parsed.artifact.authority).toBe(50);
  });
});

/**
 * The install-shape assertions from #72's reality check. These are not about parsing at all;
 * they are about the promise that nothing compiles on a user's machine.
 */
describe('no native dependency', () => {
  it('extracts text with no canvas package installed', async () => {
    // The suite itself is the evidence: `@napi-rs/canvas` is excluded in pnpm-workspace.yaml,
    // so every test above ran without it. This asserts the thing explicitly so the reason is
    // visible when someone wonders why the override is there.
    const resolved = await import('node:module').then((module) =>
      module.createRequire(import.meta.url),
    );
    expect(() => resolved.resolve('@napi-rs/canvas')).toThrow();

    const parsed = await parse([{ lines: ['Extracted without canvas'] }]);
    expect(textOf(parsed)).toContain('Extracted without canvas');
  });
});
