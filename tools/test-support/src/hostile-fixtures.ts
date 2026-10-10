import { deflateSync } from 'node:zlib';
import { makeDocx, paragraph } from './docx-fixtures.js';

/**
 * Small, valid documents that make a parser's libraries run for minutes or exhaust memory.
 *
 * Each one is the audit's reproduction for #594 at a size a test can afford. They are tuned
 * against a short deadline and a low heap ceiling, not against the shipped defaults: what a
 * test needs is a file that *certainly* exceeds the limit it sets, on the slowest CI runner,
 * without the test itself taking a minute.
 */

/** `[`×n `x` `]`×n: quadratic in micromark's label matching. */
export function nestedBracketsMarkdown(depth: number): Uint8Array {
  return utf8(`${'['.repeat(depth)}x${']'.repeat(depth)}\n`);
}

/** `<ul><li>` nested n deep: minutes in the HTML tree conversion before it overflows. */
export function nestedListHtml(depth: number): Uint8Array {
  return utf8(`<!doctype html><html><body>${'<ul><li>'.repeat(depth)}x</body></html>`);
}

/** A CSV of single-character rows: every row costs an array, so the heap fills fast. */
export function singleCharacterCsv(rows: number): Uint8Array {
  return utf8(`a\n${'a\n'.repeat(rows)}`);
}

/** A DOCX whose `word/document.xml` compresses to almost nothing and inflates to `megabytes`. */
export function docxBomb(megabytes: number): Promise<Uint8Array> {
  return makeDocx({ body: paragraph('A'.repeat(megabytes * 1024 * 1024)) });
}

/** One page whose FlateDecode content stream inflates to `megabytes` of text operators. */
export function flateBombPdf(megabytes: number): Uint8Array {
  const operator = '(AAAAAAAAAAAAAAAA) Tj ';
  const body = `BT /F1 1 Tf 0 0 Td ${operator.repeat(Math.ceil((megabytes * 1024 * 1024) / operator.length))}ET`;
  return singlePagePdf(deflateSync(Buffer.from(body, 'latin1'), { level: 9 }), {
    filter: 'FlateDecode',
  });
}

/**
 * A font whose `/ToUnicode` CMap declares `ranges` bfranges of 2^24 codes each.
 *
 * Under 1 KB. pdfjs expands every range eagerly, so one range costs gigabytes; the audit's
 * eight-range file aborted V8 with a heap out-of-memory error, which is what makes this the
 * fixture that decides between a worker thread and a process.
 */
export function cmapBombPdf(ranges: number): Uint8Array {
  const lines = Array.from({ length: ranges }, (_, index) => {
    const start = index * 0x1000000;
    return `<${hex(start)}> <${hex(start + 0xfffffe)}> <0041>`;
  });
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def 1 begincodespacerange <00000000> <FFFFFFFF> endcodespacerange ${ranges} beginbfrange\n${lines.join('\n')}\nendbfrange endcmap end end`;
  return singlePagePdf(Buffer.from('BT /F1 12 Tf 72 700 Td (hello) Tj ET', 'latin1'), {
    toUnicode: Buffer.from(cmap, 'latin1'),
  });
}

function singlePagePdf(
  content: Buffer,
  options: { filter?: string; toUnicode?: Buffer },
): Uint8Array {
  const stream = (data: Buffer, filter?: string): Buffer =>
    Buffer.concat([
      Buffer.from(
        `<< /Length ${data.length}${filter === undefined ? '' : ` /Filter /${filter}`} >>\nstream\n`,
        'latin1',
      ),
      data,
      Buffer.from('\nendstream', 'latin1'),
    ]);
  const font = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica${
    options.toUnicode === undefined ? '' : ' /ToUnicode 6 0 R'
  } >>`;
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      'latin1',
    ),
    stream(content, options.filter),
    Buffer.from(font, 'latin1'),
    ...(options.toUnicode === undefined ? [] : [stream(options.toUnicode)]),
  ];

  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')];
  let length = parts[0]?.length ?? 0;
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(part);
    length += part.length;
  }
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) trailer += `${String(offset).padStart(10, '0')} 00000 n \n`;
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(trailer, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(8, '0');
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
