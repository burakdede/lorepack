import { ZipFile } from 'yazl';

/**
 * Minimal XLSX writing, for fixtures only.
 *
 * Hand-built for the same reason as the PDF and DOCX fixtures, and with more force here: the
 * reader under test is our own, so a *writer* library would be the only third party in the
 * loop and its opinions would become our test's assumptions. Writing the XML directly means a
 * fixture states exactly what is on the wire. "A cell with `t="inlineStr"` and no shared
 * string table" is visible in the code rather than a side effect of somebody's `addRow()`.
 *
 * Only the parts the reader looks at are produced: content types, package and workbook
 * relationships, `workbook.xml`, `sharedStrings.xml`, `styles.xml` and one part per sheet.
 */

export interface SheetSpec {
  readonly name: string;
  /** Raw `<row>` elements. Written directly so a fixture can be malformed on purpose. */
  readonly rows: string;
  readonly merges?: readonly string[];
}

export interface WorkbookSpec {
  readonly sheets: readonly SheetSpec[];
  readonly sharedStrings?: readonly string[];
  /** Extra `<numFmt>` entries, for custom date formats. */
  readonly numberFormats?: readonly { id: number; code: string }[];
  /** `cellXfs` entries as `numFmtId`s. Index into this is a cell's `s` attribute. */
  readonly cellFormats?: readonly number[];
  readonly date1904?: boolean;
  /** Replaces `sharedStrings.xml` wholesale, for the entity-expansion tests. */
  readonly rawSharedStrings?: string;
}

export function makeXlsx(spec: WorkbookSpec): Promise<Uint8Array> {
  const zip = new ZipFile();
  const add = (name: string, contents: string): void => {
    zip.addBuffer(Buffer.from(contents, 'utf8'), name);
  };

  const sheetParts = spec.sheets.map((_, index) => `xl/worksheets/sheet${String(index + 1)}.xml`);

  add(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`,
  );
  add(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  );

  // Relationship ids deliberately do not match the file numbers in every fixture, because the
  // reader must resolve sheets through relationships rather than by sorting file names.
  const relationships = spec.sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${String(index + 10)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`,
    )
    .join('');
  add(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}
  <Relationship Id="rIdShared" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );

  const sheetTags = spec.sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${String(index + 1)}" r:id="rId${String(index + 10)}"/>`,
    )
    .join('');
  add(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr date1904="${spec.date1904 === true ? '1' : '0'}"/>
  <sheets>${sheetTags}</sheets>
</workbook>`,
  );

  add(
    'xl/sharedStrings.xml',
    spec.rawSharedStrings ??
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${(spec.sharedStrings ?? [])
        .map((text) => `<si><t>${escapeXml(text)}</t></si>`)
        .join('')}</sst>`,
  );

  const numberFormats = (spec.numberFormats ?? [])
    .map(
      (format) =>
        `<numFmt numFmtId="${String(format.id)}" formatCode="${escapeXml(format.code)}"/>`,
    )
    .join('');
  const cellFormats = (spec.cellFormats ?? [0])
    .map((id) => `<xf numFmtId="${String(id)}" applyNumberFormat="1"/>`)
    .join('');
  add(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts>${numberFormats}</numFmts>
  <cellXfs count="${String((spec.cellFormats ?? [0]).length)}">${cellFormats}</cellXfs>
</styleSheet>`,
  );

  for (const [index, sheet] of spec.sheets.entries()) {
    const merges =
      sheet.merges === undefined || sheet.merges.length === 0
        ? ''
        : `<mergeCells count="${String(sheet.merges.length)}">${sheet.merges
            .map((ref) => `<mergeCell ref="${ref}"/>`)
            .join('')}</mergeCells>`;
    add(
      sheetParts[index] as string,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheet.rows}</sheetData>${merges}
</worksheet>`,
    );
  }

  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
  });
}

/** A row of cells, each written as its raw XML so a fixture can say exactly what it means. */
export function row(index: number, cells: readonly string[]): string {
  return `<row r="${String(index)}">${cells.join('')}</row>`;
}

/** A shared-string cell, referencing the table by index. How Excel writes most text. */
export function shared(reference: string, index: number): string {
  return `<c r="${reference}" t="s"><v>${String(index)}</v></c>`;
}

/** An inline string: what some writers emit instead of using the shared table. */
export function inlineString(reference: string, text: string): string {
  return `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;
}

export function number(reference: string, value: number, style?: number): string {
  const attribute = style === undefined ? '' : ` s="${String(style)}"`;
  return `<c r="${reference}"${attribute}><v>${String(value)}</v></c>`;
}

export function boolean_(reference: string, value: boolean): string {
  return `<c r="${reference}" t="b"><v>${value ? '1' : '0'}</v></c>`;
}

/** A cell holding a formula and its cached result. The formula text is what we keep. */
export function formula(
  reference: string,
  expression: string,
  cached: number | string,
  type?: 'str',
): string {
  const attribute = type === undefined ? '' : ` t="${type}"`;
  return `<c r="${reference}"${attribute}><f>${escapeXml(expression)}</f><v>${escapeXml(String(cached))}</v></c>`;
}

/** An error cell, as a broken reference produces. */
export function errorCell(reference: string, token: string): string {
  return `<c r="${reference}" t="e"><v>${token}</v></c>`;
}

export function empty(reference: string): string {
  return `<c r="${reference}"/>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
