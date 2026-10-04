#!/usr/bin/env node
/**
 * Write the binary members of the benchmark corpus.
 *
 * The benchmark reads these as ordinary PDF and XLSX files. Keeping their tiny writers here
 * makes the corpus reproducible without adding a document-writing dependency to the product.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from '../tools/test-support/node_modules/yazl/index.js';

const root = join(import.meta.dirname, '..', 'benchmarks', 'corpus', 'generated');
mkdirSync(root, { recursive: true });

function pdfText(text) {
  return text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

export function makePdf(pages) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObject = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const lines of pages) {
    const stream = `BT /F1 12 Tf 72 720 Td 14 TL\n${lines.map((line) => `(${pdfText(line)}) Tj T*`).join('\n')}\nET`;
    const contents = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObject} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> /MediaBox [0 0 612 792] /Contents ${contents} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObject} 0 R >>`;
  objects[pagesObject - 1] =
    `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let output = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'latin1');
}

export function makeXlsx() {
  const zip = new yazl.ZipFile();
  const date = new Date('1980-01-01T00:00:00Z');
  const add = (name, contents) => zip.addBuffer(Buffer.from(contents), name, { mtime: date });
  add(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  );
  add(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  add(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  add(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Environments" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  add(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>environment</t></is></c><c r="B1" t="inlineStr"><is><t>region</t></is></c><c r="C1" t="inlineStr"><is><t>tier</t></is></c><c r="D1" t="inlineStr"><is><t>monthly_cost_usd</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>production</t></is></c><c r="B2" t="inlineStr"><is><t>eu-west-1</t></is></c><c r="C2" t="inlineStr"><is><t>critical</t></is></c><c r="D2"><v>4210.5</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>staging</t></is></c><c r="B3" t="inlineStr"><is><t>eu-west-1</t></is></c><c r="C3" t="inlineStr"><is><t>standard</t></is></c><c r="D3"><v>318.75</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>sandbox</t></is></c><c r="B4" t="inlineStr"><is><t>us-east-1</t></is></c><c r="C4" t="inlineStr"><is><t>standard</t></is></c><c r="D4"><v>96.2</v></c></row></sheetData></worksheet>',
  );
  add(
    'xl/sharedStrings.xml',
    '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>',
  );
  add(
    'xl/styles.xml',
    '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>',
  );
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(
    join(root, 'release-notes.pdf'),
    makePdf([
      ['Release notes', 'The active build is immutable.'],
      ['Rollback', 'Activation changes a pointer and does not recompile sources.'],
    ]),
  );
  writeFileSync(join(root, 'environments.xlsx'), await makeXlsx());
  console.log(`Wrote ${dirname(root)} fixtures`);
}
