/**
 * Minimal PDF writing, for fixtures only.
 *
 * Hand-built rather than taken from a library, for two reasons. A PDF *writer* would be a
 * dependency that only tests use, to exercise a reader we are testing, which is a strange
 * thing to add to a lockfile. And building the bytes here means a fixture is legible: the
 * scanned-document case is "a page with an image and no text operators", which is visible in
 * the code rather than hidden inside somebody's `addImage()`.
 *
 * This produces valid PDF 1.4 with a correct cross-reference table, which is what makes the
 * corrupt-file tests meaningful: they corrupt something that was genuinely well-formed.
 */

export interface PageSpec {
  /** Lines of text. Empty means a page with no text layer, like a scan. */
  readonly lines: readonly string[];
  /** Adds an image XObject with no text, which is what a scanned page looks like. */
  readonly image?: boolean;
}

export function makePdf(
  pages: readonly PageSpec[],
  options: { title?: string; withNulByte?: boolean } = {},
): Uint8Array {
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  // Reserved so /Pages can reference its kids before they exist.
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const kids: number[] = [];
  for (const page of pages) {
    const stream = page.lines.length
      ? `BT /F1 12 Tf 72 720 Td 14 TL\n${page.lines
          .map((line) => `(${escapeText(line)}) Tj T*`)
          .join('\n')}\nET`
      : // A page that draws a rectangle and no text: glyphless, like a scan.
        page.image === true
        ? '0.5 0.5 0.5 rg 72 500 400 200 re f'
        : '';
    const contentsId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> /MediaBox [0 0 612 792] /Contents ${contentsId} 0 R >>`,
      ),
    );
  }

  const infoId =
    options.title === undefined ? null : add(`<< /Title (${escapeText(options.title)}) >>`);

  /**
   * A NUL byte, which real PDFs have and this writer otherwise does not.
   *
   * Worth an option rather than always-on, because it is the *only* thing that made #222
   * reproducible: a PDF written by any real tool has compressed streams full of NULs and was
   * excluded from every build as "binary", while this hand-built fixture was pure ASCII and
   * sailed through. A test that passes by luck is worse than no test.
   */
  if (options.withNulByte === true) {
    objects.push(`<< /Type /Metadata /Note (\u0000binary) >>`);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }

  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R${
    infoId === null ? '' : ` /Info ${infoId} 0 R`
  } >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return latin1(out);
}

/**
 * A password-protected document, for the refusal path.
 *
 * The standard security handler needs `/V`, `/R`, `/O`, `/U` and `/P` **and** a trailer `/ID`.
 * A partial dictionary does not raise `PasswordException`; it raises a generic parse failure,
 * which would let the test pass against the wrong branch. Verified against pdfjs 6.2.108 that
 * this shape produces `PasswordException: No password given`.
 */
export function makeEncryptedPdf(): Uint8Array {
  const padded = (character: string): string => `<${character.repeat(64)}>`;
  return latin1(
    [
      '%PDF-1.4',
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj',
      `4 0 obj\n<< /Filter /Standard /V 1 /R 2 /O ${padded('a')} /U ${padded('b')} /P -1 >>\nendobj`,
      `trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [${padded('c')} ${padded('c')}] >>`,
      '%%EOF',
      '',
    ].join('\n'),
  );
}

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** PDF syntax is byte-oriented; the offsets above are byte offsets, so encode one-to-one. */
function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}
