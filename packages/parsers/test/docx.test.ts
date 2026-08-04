import { hashBytes, LoreError, type ParsedArtifact, type ParseInput } from '@lorepack/core';
import { makeDocx, paragraph, table, trackedChange } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { docxParser } from '../src/docx/parser.js';

/**
 * DOCX, which normalizes through the HTML parser.
 *
 * The interesting assertions are about the seam. Word structure has to arrive as the same node
 * kinds a `.html` file produces, the artifact has to say `docx` rather than claiming to be
 * HTML, and every flattening decision has to be visible as a warning rather than silent.
 */

async function parse(body: string, relativePath = 'doc.docx'): Promise<ParsedArtifact> {
  return parseBytes(await makeDocx({ body }), relativePath);
}

async function parseBytes(bytes: Uint8Array, relativePath = 'doc.docx'): Promise<ParsedArtifact> {
  const input: ParseInput = {
    artifactId: `p:${relativePath}`,
    sourceId: 'p',
    relativePath,
    displayPath: relativePath,
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    byteSize: bytes.byteLength,
    contentHash: hashBytes(bytes),
    bytes,
  };
  return (await docxParser.parse(input)) as ParsedArtifact;
}

const kinds = (parsed: ParsedArtifact): string[] => parsed.nodes.map((node) => node.kind);
const texts = (parsed: ParsedArtifact): string =>
  parsed.nodes.map((node) => node.text ?? node.title ?? '').join(' | ');

describe('Word structure becomes the same nodes as HTML', () => {
  it('maps heading styles to nested sections with the heading path', async () => {
    const parsed = await parse(
      [
        paragraph('Deployment guide', 'Heading1'),
        paragraph('Deploy on a Tuesday.'),
        paragraph('Rolling back', 'Heading2'),
        paragraph('Run the command.'),
      ].join(''),
    );

    const sections = parsed.nodes.filter((node) => node.kind === 'section');
    expect(sections.map((node) => node.title)).toEqual(['Deployment guide', 'Rolling back']);
    expect(
      parsed.nodes.find((node) => node.text === 'Run the command.')?.locator.headingPath,
    ).toEqual(['Deployment guide', 'Rolling back']);
  });

  it('preserves a table as a table node with its cell text', async () => {
    const parsed = await parse(
      table([
        ['Step', 'Owner'],
        ['Announce', 'Release manager'],
      ]),
    );
    const found = parsed.nodes.find((node) => node.kind === 'table');
    expect(found?.text).toContain('Announce');
    expect(found?.text).toContain('Release manager');
    expect(found?.metadata).toMatchObject({ rows: 2 });
  });

  it('records the parser as docx rather than claiming to be HTML', async () => {
    const parsed = await parse(paragraph('Anything.'));
    expect(parsed.artifact.parserId).toBe('docx');
  });

  it('takes the title from the first heading', async () => {
    const parsed = await parse(
      [paragraph('Requirements', 'Heading1'), paragraph('Body.')].join(''),
    );
    expect(parsed.artifact.title).toBe('Requirements');
  });
});

describe('what is flattened is visible', () => {
  /**
   * The information only exists at conversion time. Once the HTML is produced, a paragraph
   * that was styled `CustomCallout` is indistinguishable from one that was never styled.
   */
  it('names every unmapped Word style once, rather than per paragraph', async () => {
    const parsed = await parse(
      [
        paragraph('a', 'CustomCallout'),
        paragraph('b', 'CustomCallout'),
        paragraph('c', 'CustomCallout'),
        paragraph('d', 'AnotherStyle'),
      ].join(''),
    );

    const warning = parsed.warnings.find((one) => one.code === 'docx-unmapped-style');
    expect(warning?.message).toContain('AnotherStyle');
    expect(warning?.message).toContain('CustomCallout');
    // One warning for four paragraphs in two styles, not four.
    expect(parsed.warnings.filter((one) => one.code === 'docx-unmapped-style')).toHaveLength(1);
  });

  it('resolves a tracked change to the accepted text', async () => {
    const parsed = await parse(trackedChange('the new wording', 'the old wording'));
    expect(texts(parsed)).toContain('the new wording');
    expect(texts(parsed)).not.toContain('the old wording');
  });

  /**
   * Word paginates at render time against a page size, a font set and a printer, so a page
   * number is a property of a rendering rather than of the document. Saying so beats an
   * invented number, and beats silence.
   */
  it('says plainly that a DOCX has no page numbers', async () => {
    const parsed = await parse(paragraph('Anything.'));
    expect(String(parsed.artifact.metadata.pagination)).toContain('no page numbers');
    for (const node of parsed.nodes) {
      expect(node.metadata).not.toHaveProperty('page');
    }
  });
});

describe('refusals', () => {
  it('refuses a legacy .doc by name rather than failing obscurely', async () => {
    const bytes = await makeDocx({ body: paragraph('x') });
    const failure = await parseBytes(bytes, 'old.doc').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LoreError);
    const error = failure as LoreError;
    expect(error.message).toContain('legacy .doc');
    // Naming the fix is the point: "could not find the body element" sends someone hunting
    // for a corrupt file rather than reaching for save-as.
    expect(error.remediation).toContain('save as .docx');
  });

  it('fails a corrupt archive with an actionable message', async () => {
    const failure = await parseBytes(new TextEncoder().encode('not a zip at all')).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LoreError);
    expect((failure as LoreError).remediation).toMatch(/password|corrupt/i);
  });

  it('fails a document whose xml is not xml', async () => {
    const bytes = await makeDocx({ body: '', corrupt: true });
    const failure = await parseBytes(bytes).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LoreError);
  });
});

describe('security and determinism', () => {
  /**
   * A user writing *about* markup must get their words back.
   *
   * The chain is worth stating because it is easy to break in either direction. Word stores
   * the characters, mammoth escapes them into `&lt;script&gt;`, and the HTML stage decodes
   * entities back to characters. So the text survives **as text**: it was never an element,
   * so there was never anything to execute, and equally nothing was silently deleted.
   *
   * Getting this wrong in the other direction is the real risk. If mammoth emitted the
   * characters unescaped, the HTML stage would see a genuine `<script>` element and drop it
   * with its contents, and a paragraph the author wrote would vanish from the build.
   */
  it('round-trips text that looks like markup, as text', async () => {
    const parsed = await parse(paragraph('<script>alert(1)</script> and <b>bold</b>'));
    const paragraphNode = parsed.nodes.find((node) => node.kind === 'paragraph');

    expect(paragraphNode?.text).toBe('<script>alert(1)</script> and <b>bold</b>');
    // It is text in a column, not an element: no node claims to be code or a script.
    expect(parsed.nodes.every((node) => node.kind !== 'code')).toBe(true);
  });

  it('produces identical output on a second parse', async () => {
    const bytes = await makeDocx({
      body: [paragraph('Title', 'Heading1'), paragraph('Body.')].join(''),
    });
    const first = await parseBytes(bytes);
    const second = await parseBytes(bytes);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('starts every artifact neutral, leaving status and authority to the rule stage', async () => {
    const parsed = await parse(paragraph('Anything.'));
    expect(parsed.artifact.status).toBe('active');
    expect(parsed.artifact.authority).toBe(50);
  });

  it('produces a document node for an empty document', async () => {
    const parsed = await parse('');
    expect(kinds(parsed)).toContain('document');
  });
});
