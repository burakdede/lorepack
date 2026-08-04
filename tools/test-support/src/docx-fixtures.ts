import { ZipFile } from 'yazl';

/**
 * Minimal DOCX writing, for fixtures only.
 *
 * A `.docx` is a ZIP of XML parts, so this builds one directly with `yazl`, which the
 * workspace already uses to write `.lorepack`. Hand-built for the same reason as the PDF
 * fixtures: a document *writer* in the lockfile to test a *reader* is a strange trade, and a
 * fixture assembled here is legible. "A heading styled Heading1" is visible in the code rather
 * than hidden behind somebody's `addHeading()`.
 *
 * Only the parts mammoth actually reads are produced: the content types, the package
 * relationships, `word/document.xml`, and optionally `word/styles.xml`, `word/footnotes.xml`
 * and their relationship entries.
 */

export interface DocxParts {
  /** The `<w:body>` contents. */
  readonly body: string;
  /** Style definitions, for custom style mapping. */
  readonly styles?: string;
  readonly footnotes?: string;
  /** Written instead of a real document part, to make a corrupt file. */
  readonly corrupt?: boolean;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
</Relationships>`;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export function makeDocx(parts: DocxParts): Promise<Uint8Array> {
  const zip = new ZipFile();
  const add = (name: string, contents: string): void => {
    zip.addBuffer(Buffer.from(contents, 'utf8'), name);
  };

  add('[Content_Types].xml', CONTENT_TYPES);
  add('_rels/.rels', PACKAGE_RELS);
  add('word/_rels/document.xml.rels', DOCUMENT_RELS);
  add(
    'word/document.xml',
    parts.corrupt === true
      ? 'this is not xml at all'
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${parts.body}</w:body></w:document>`,
  );
  add(
    'word/styles.xml',
    parts.styles ??
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${W}></w:styles>`,
  );
  add(
    'word/footnotes.xml',
    parts.footnotes ??
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:footnotes ${W}></w:footnotes>`,
  );

  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
  });
}

/** A paragraph in a named Word style, which is what mammoth maps to semantics. */
export function paragraph(text: string, style?: string): string {
  const properties = style === undefined ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  return `<w:p>${properties}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** A table, as Word writes one: rows of cells of paragraphs. */
export function table(rows: readonly (readonly string[])[]): string {
  const cells = rows
    .map((row) => `<w:tr>${row.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`)
    .join('');
  return `<w:tbl>${cells}</w:tbl>`;
}

/** An insertion and a deletion, which is what a tracked change looks like on the wire. */
export function trackedChange(inserted: string, deleted: string): string {
  return `<w:p><w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:t xml:space="preserve">${escapeXml(
    inserted,
  )}</w:t></w:r></w:ins><w:del w:id="2" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">${escapeXml(
    deleted,
  )}</w:delText></w:r></w:del></w:p>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
