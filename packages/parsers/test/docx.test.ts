import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashBytes, LoreError, type ParsedArtifact, type ParseInput } from '@lorepack/core';
import { docxBomb, makeDocx, paragraph, table, trackedChange } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
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

type DocxFixturePhase =
  | 'allocation-start'
  | 'allocation-done'
  | 'zip-begin'
  | 'part-add-start'
  | 'part-add-returned'
  | 'zip-end-returned'
  | 'zip-first-output'
  | 'zip-assembly-start'
  | 'zip-assembled'
  | 'parser-assertion-start'
  | 'parser-assertion-passed';

type DocxFixtureObserver = (phase: DocxFixturePhase, part?: number, bytes?: number) => void;

async function packageWithExtraParts(
  parts: readonly { name: string; content: string | Uint8Array }[],
  body = paragraph('original'),
  observe?: DocxFixtureObserver,
): Promise<Uint8Array> {
  observe?.('zip-begin');
  const zip = new yazl.ZipFile();
  const document = (body: string): string =>
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`;
  const defaults = [
    {
      name: '[Content_Types].xml',
      content:
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      content:
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    { name: 'word/document.xml', content: document(body) },
    {
      name: 'word/_rels/document.xml.rels',
      content:
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="file:///tmp/missing-lorepack-image.png" TargetMode="External"/></Relationships>',
    },
  ];
  let partIndex = 0;
  for (const part of [...defaults, ...parts]) {
    const content =
      typeof part.content === 'string'
        ? Buffer.from(part.content)
        : Buffer.from(part.content.buffer, part.content.byteOffset, part.content.byteLength);
    observe?.('part-add-start', partIndex, content.byteLength);
    zip.addBuffer(content, part.name);
    observe?.('part-add-returned', partIndex, content.byteLength);
    partIndex += 1;
  }
  zip.end();
  observe?.('zip-end-returned');
  return await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let outputStarted = false;
    zip.outputStream.on('data', (chunk: Buffer) => {
      if (!outputStarted) {
        observe?.('zip-first-output');
        outputStarted = true;
      }
      chunks.push(chunk);
    });
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => {
      observe?.('zip-assembly-start');
      const bytes = new Uint8Array(Buffer.concat(chunks));
      observe?.('zip-assembled', undefined, bytes.byteLength);
      resolve(bytes);
    });
  });
}

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
  it('rejects duplicate package parts before mammoth chooses a copy', async () => {
    const bytes = await packageWithExtraParts([
      {
        name: 'word/document.xml',
        content:
          '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>second</w:t></w:r></w:p></w:body></w:document>',
      },
    ]);
    await expect(parseBytes(bytes)).rejects.toMatchObject({
      code: 'LORE_E_UNSUPPORTED_FORMAT',
      message: expect.stringContaining('duplicate'),
    });
  });

  it('rejects a document part that expands beyond the DOCX cap', async () => {
    const parserPath = join(import.meta.dirname, '..', 'dist', 'docx', 'parser.js');
    const corePath = join(import.meta.dirname, '..', '..', 'core', 'dist', 'index.js');
    expect(existsSync(parserPath), 'Build the DOCX parser before this regression.').toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'lore-docx-limit-'));
    try {
      const bytes = await docxBomb(100);
      const path = join(root, 'bomb.docx');
      writeFileSync(path, bytes);
      const code = `
import {readFileSync} from 'node:fs';
import {docxParser} from ${JSON.stringify(pathToFileURL(parserPath).href)};
import {hashBytes} from ${JSON.stringify(pathToFileURL(corePath).href)};
const bytes=readFileSync(process.argv[1]);
const input={artifactId:'fixture:bomb.docx',sourceId:'fixture',relativePath:'bomb.docx',
 displayPath:'bomb.docx',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 byteSize:bytes.byteLength,contentHash:hashBytes(bytes),bytes};
try {
  await docxParser.parse(input);
  process.stderr.write('The bomb was accepted.');
  process.exitCode=2;
} catch (error) {
  process.stdout.write(JSON.stringify({code:error?.code,message:error?.message})+'\\n');
}
`;
      const result = spawnSync(
        process.execPath,
        ['--max-old-space-size=128', '--input-type=module', '-e', code, path],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.signal ?? ''}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ code: 'LORE_E_ENVELOPE_EXCEEDED' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);

  it('rejects an archive with too many parts', async () => {
    const extras = Array.from({ length: 509 }, (_, index) => ({
      name: `word/extra-${String(index)}.xml`,
      content: '<x/>',
    }));
    const bytes = await packageWithExtraParts(extras);
    await expect(parseBytes(bytes)).rejects.toMatchObject({
      code: 'LORE_E_ENVELOPE_EXCEEDED',
    });
  });

  it('rejects package bytes spread across individually allowed parts', async ({ onTestFailed }) => {
    const started = performance.now();
    const events: { phase: DocxFixturePhase; elapsedMs: number; part?: number; bytes?: number }[] =
      [];
    const observe: DocxFixtureObserver = (phase, part, bytes) => {
      if (events.length < 32) {
        events.push({
          phase,
          elapsedMs: performance.now() - started,
          ...(part === undefined ? {} : { part }),
          ...(bytes === undefined ? {} : { bytes }),
        });
      }
    };
    onTestFailed(() => {
      console.error(
        'DOCX aggregate-byte phase snapshot',
        JSON.stringify({
          node: process.version,
          platform: process.platform,
          pid: process.pid,
          elapsedMs: performance.now() - started,
          events,
        }),
      );
    });
    observe('allocation-start');
    const content = Buffer.alloc(55 * 1024 * 1024, 65);
    observe('allocation-done', undefined, content.byteLength);
    const bytes = await packageWithExtraParts(
      Array.from({ length: 3 }, (_, index) => ({
        name: `word/extra-${String(index)}.bin`,
        content,
      })),
      undefined,
      observe,
    );
    observe('parser-assertion-start', undefined, bytes.byteLength);
    await expect(parseBytes(bytes)).rejects.toMatchObject({
      code: 'LORE_E_ENVELOPE_EXCEEDED',
    });
    observe('parser-assertion-passed');
  });

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

describe('conversion losses', () => {
  it('warns when mammoth cannot include an externally linked image', async () => {
    const image =
      '<w:p><w:r><w:pict><v:shape><v:imagedata r:id="rIdImage"/></v:shape></w:pict></w:r></w:p>';
    const bytes = await packageWithExtraParts([], image);
    const parsed = await parseBytes(bytes);
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'docx-dropped-content',
          message: expect.stringMatching(/1 content item could not be included/i),
          loss: {},
        }),
      ]),
    );
    expect(
      parsed.warnings.filter((warning) => warning.code === 'docx-dropped-content'),
    ).toHaveLength(1);
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
