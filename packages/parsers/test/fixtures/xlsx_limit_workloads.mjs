import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

const destination = process.argv[2];
if (destination === undefined) {
  throw new Error('Pass an output directory for the reconstructed XLSX workloads.');
}

await mkdir(destination, { recursive: true });

const mib = 1024 * 1024;
const chunksOfX = async function* (count) {
  const chunk = Buffer.alloc(mib, 120);
  for (let index = 0; index < count; index += 1) yield chunk;
};

function textPart(zip, name, xml) {
  zip.addBuffer(Buffer.from(xml), name);
}

function streamPart(zip, name, chunks) {
  zip.addReadStream(Readable.from(chunks), name);
}

async function writeWorkbook(name, sheetCount, sharedStrings, sheetXml) {
  const zip = new yazl.ZipFile();
  textPart(
    zip,
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  );
  textPart(
    zip,
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<sheet name="Sheet${String(index + 1)}" sheetId="${String(index + 1)}" r:id="rId${String(index + 10)}"/>`,
  ).join('');
  textPart(
    zip,
    'xl/workbook.xml',
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`,
  );
  const relationships = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${String(index + 10)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>`,
  ).join('');
  textPart(
    zip,
    'xl/_rels/workbook.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}<Relationship Id="rIdShared" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  textPart(zip, 'xl/styles.xml', '<styleSheet><cellXfs><xf numFmtId="0"/></cellXfs></styleSheet>');
  streamPart(zip, 'xl/sharedStrings.xml', sharedStrings);
  streamPart(zip, 'xl/worksheets/sheet1.xml', sheetXml);
  zip.end();

  const path = join(destination, name);
  await pipeline(zip.outputStream, createWriteStream(path));
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  process.stdout.write(`${JSON.stringify({ name, bytes, sha256: hash.digest('hex') })}\n`);
}

async function* emptyStrings() {
  yield '<sst/>';
}

async function* aliasSheet() {
  yield '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c></row>';
  for (let index = 0; index < 39_999; index += 1) {
    const row = index + 2;
    yield `<row r="${String(row)}"><c r="A${String(row)}" t="inlineStr"><is><t>value</t></is></c></row>`;
  }
  yield '</sheetData></worksheet>';
}

async function* smallSheet() {
  yield '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c></row><row r="2"><c r="A2" t="s"><v>0</v></c></row></sheetData></worksheet>';
}

async function* manyStrings() {
  yield '<sst>';
  const block = '<si><t>x</t></si>'.repeat(1000);
  for (let index = 0; index < 33_000; index += 1) yield block;
  yield '<si><t>x</t></si></sst>';
}

async function* largeSharedString() {
  yield '<sst><si><t>';
  yield* chunksOfX(1024);
  yield '</t></si></sst>';
}

async function* largeInlineCell() {
  yield '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>';
  yield* chunksOfX(1024);
  yield '</t></is></c></row></sheetData></worksheet>';
}

await writeWorkbook('alias256.xlsx', 256, emptyStrings(), aliasSheet());
await writeWorkbook('manystrings.xlsx', 1, manyStrings(), smallSheet());
await writeWorkbook('bomb.xlsx', 1, emptyStrings(), largeInlineCell());
await writeWorkbook('bigstring.xlsx', 1, largeSharedString(), smallSheet());
