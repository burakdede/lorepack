import type { Package } from './zip.js';

/**
 * The parts of a workbook that are not the cells: sheet names, the date system, the shared
 * string table, and the number formats that decide whether `45678` is a number or a date.
 */

export interface SheetRef {
  readonly name: string;
  /** The part to stream. Resolved through relationships, never guessed from the order. */
  readonly part: string;
}

export interface WorkbookParts {
  readonly sheets: readonly SheetRef[];
  readonly sharedStrings: readonly string[];
  readonly dateStyles: ReadonlySet<number>;
  /**
   * Which epoch this workbook counts from.
   *
   * Excel supports two, set per file, and reading a 1904 workbook as 1900 shifts **every**
   * date by four years and one day. Nothing looks broken: the dates are plausible, merely
   * wrong, which is why the ticket calls this out as a required fixture rather than trusting
   * that the default is safe.
   */
  readonly date1904: boolean;
}

export async function readWorkbookParts(pkg: Package): Promise<WorkbookParts> {
  const [sheets, sharedStrings, styles] = [
    await readSheets(pkg),
    await readSharedStrings(pkg),
    await readStyles(pkg),
  ];
  return {
    sheets: sheets.refs,
    sharedStrings,
    dateStyles: styles,
    date1904: sheets.date1904,
  };
}

/**
 * Sheet names and their parts, resolved through the relationship file.
 *
 * The tempting shortcut is to sort `xl/worksheets/sheet*.xml` and zip it against the names in
 * `workbook.xml`. That is wrong whenever a sheet has been deleted or reordered, because the
 * file numbers do not renumber and `sheet3.xml` can be the second sheet. Relationships are
 * the only mapping the format actually guarantees.
 */
async function readSheets(pkg: Package): Promise<{ refs: SheetRef[]; date1904: boolean }> {
  const relationships = new Map<string, string>();
  await pkg.readXml('xl/_rels/workbook.xml.rels', {
    open: (name, attributes) => {
      if (name !== 'Relationship') return;
      const id = attributes.Id;
      const target = attributes.Target;
      if (id !== undefined && target !== undefined) relationships.set(id, normalizeTarget(target));
    },
  });

  const declared: { name: string; rid: string | undefined }[] = [];
  let date1904 = false;
  await pkg.readXml('xl/workbook.xml', {
    open: (name, attributes) => {
      if (name === 'sheet') {
        declared.push({
          name: attributes.name ?? `Sheet${String(declared.length + 1)}`,
          rid: attributes['r:id'] ?? attributes.id,
        });
        return;
      }
      // Written as `date1904="1"` by Excel for Mac's old default, and as `dateCompatibility`
      // by some writers. Both are read, because being wrong here is silent.
      if (name === 'workbookPr') {
        const flag = attributes.date1904 ?? attributes.dateCompatibility ?? '0';
        date1904 = flag === '1' || flag.toLowerCase() === 'true';
      }
    },
  });

  const fallback = [...pkg.entries.keys()]
    .filter((key) => /^xl\/worksheets\/sheet\d+\.xml$/.test(key))
    .sort();

  const refs: SheetRef[] = [];
  for (const [index, sheet] of declared.entries()) {
    const viaRelationship = sheet.rid === undefined ? undefined : relationships.get(sheet.rid);
    const part = viaRelationship ?? fallback[index];
    if (part === undefined || !pkg.entries.has(part)) continue;
    refs.push({ name: sheet.name, part });
  }
  return { refs, date1904 };
}

/** Relationship targets are relative to `xl/`, and may be written with a leading slash. */
function normalizeTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return target.startsWith('xl/') ? target : `xl/${target}`;
}

/**
 * The shared string table, which is the one part that must be held whole.
 *
 * Bounded by the workbook's own distinct-string count rather than by its cell count, which is
 * what makes it affordable: a 500,000-row sheet of repeated categories has a handful of
 * entries here. A cell referencing an index past the end reads as empty rather than throwing,
 * because a damaged table should cost one cell and not the file.
 */
async function readSharedStrings(pkg: Package): Promise<string[]> {
  const strings: string[] = [];
  let depth = 0;
  let buffer = '';
  let inText = false;

  await pkg.readXml('xl/sharedStrings.xml', {
    open: (name) => {
      if (name === 'si') {
        depth = 1;
        buffer = '';
        return;
      }
      // `t` inside `rPh` is a phonetic hint for Japanese text, not the string itself, and
      // concatenating it would append furigana to every such cell.
      if (name === 'rPh') depth = 0;
      if (name === 't' && depth === 1) inText = true;
    },
    text: (value) => {
      if (inText) buffer += value;
    },
    close: (name) => {
      if (name === 't') inText = false;
      else if (name === 'rPh') depth = 1;
      else if (name === 'si') {
        // A rich-text string is several `t` runs inside one `si`, concatenated: the runs are
        // formatting, and formatting is not content.
        strings.push(buffer);
        depth = 0;
      }
    },
  });
  return strings;
}

/** Built-in number format ids that mean a date or a time (ECMA-376, section 18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/**
 * The style indices whose cells hold dates.
 *
 * An Excel date is **a number plus a style**, with nothing in the cell itself to say so. So
 * this walks `cellXfs` to map a cell's style index to a format id, and separately collects
 * custom format ids whose code contains date tokens. Missing either half means a date column
 * silently arrives as five-digit integers.
 *
 * Date tokens are looked for only after stripping `[...]` sections and quoted literals: a
 * currency format like `"$"#,##0.00` contains no date, but its literal contains an `s` that a
 * naive test would match, turning every price into a date.
 */
async function readStyles(pkg: Package): Promise<Set<number>> {
  const customDateFormats = new Set<number>();
  const formatOfStyle: number[] = [];
  let inCellXfs = false;

  await pkg.readXml('xl/styles.xml', {
    open: (name, attributes) => {
      if (name === 'cellXfs') {
        inCellXfs = true;
        return;
      }
      if (name === 'xf' && inCellXfs) {
        formatOfStyle.push(Number(attributes.numFmtId ?? '0'));
        return;
      }
      if (name === 'numFmt') {
        const code = String(attributes.formatCode ?? '').replace(/\[[^\]]*\]|"[^"]*"/g, '');
        if (/[dmyhs]/i.test(code)) customDateFormats.add(Number(attributes.numFmtId));
      }
    },
    close: (name) => {
      if (name === 'cellXfs') inCellXfs = false;
    },
  });

  const dateStyles = new Set<number>();
  for (const [style, format] of formatOfStyle.entries()) {
    if (BUILTIN_DATE_FORMATS.has(format) || customDateFormats.has(format)) dateStyles.add(style);
  }
  return dateStyles;
}
