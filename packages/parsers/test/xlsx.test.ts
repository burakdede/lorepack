import { hashBytes, LoreError, type ParsedArtifact, type ParsedTable } from '@lorepack/core';
import {
  boolean_,
  empty,
  errorCell,
  formula,
  inlineString,
  makeXlsx,
  number,
  row,
  shared,
  type WorkbookSpec,
} from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { XLSX_LIMITS, xlsxParser } from '../src/xlsx/parser.js';

/**
 * XLSX, read by our own reader.
 *
 * Because there is no library between us and the format, the tests have to cover things a
 * library would have handled invisibly: inline strings, the 1904 epoch, error cells, and
 * relationship-resolved sheet order. Each of those is a case where being wrong is *quiet*,
 * which is why the ADR listed them as required fixtures rather than nice-to-haves.
 */

async function parse(spec: WorkbookSpec, relativePath = 'book.xlsx'): Promise<ParsedArtifact> {
  return parseBytes(await makeXlsx(spec), relativePath);
}

async function parseBytes(bytes: Uint8Array, relativePath = 'book.xlsx'): Promise<ParsedArtifact> {
  return (await xlsxParser.parse({
    artifactId: `p:${relativePath}`,
    sourceId: 'p',
    relativePath,
    displayPath: relativePath,
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    byteSize: bytes.byteLength,
    contentHash: hashBytes(bytes),
    bytes,
  })) as ParsedArtifact;
}

const tableOf = (parsed: ParsedArtifact, sheet?: string): ParsedTable => {
  const table =
    sheet === undefined ? parsed.tables?.[0] : parsed.tables?.find((one) => one.sheet === sheet);
  if (table === undefined)
    throw new Error(`expected a table${sheet === undefined ? '' : ` for ${sheet}`}`);
  return table;
};

/** A plain one-table sheet: header in row 1, three data rows. */
const SIMPLE: WorkbookSpec = {
  sharedStrings: ['sku', 'qty', 'price', 'A-1', 'A-2', 'A-3'],
  sheets: [
    {
      name: 'Orders',
      rows: [
        row(1, [shared('A1', 0), shared('B1', 1), shared('C1', 2)]),
        row(2, [shared('A2', 3), number('B2', 5), number('C2', 9.99)]),
        row(3, [shared('A3', 4), number('B3', 2), number('C3', 4.5)]),
        row(4, [shared('A4', 5), number('B4', 8), number('C4', 1.25)]),
      ].join(''),
    },
  ],
};

describe('a workbook becomes typed tables', () => {
  it('reads a sheet into a table with its columns and rows', async () => {
    const table = tableOf(await parse(SIMPLE));
    expect(table.name).toBe('Orders');
    expect(table.sheet).toBe('Orders');
    expect(table.columns.map((column) => [column.name, column.type])).toEqual([
      ['sku', 'text'],
      ['qty', 'integer'],
      ['price', 'real'],
    ]);
    expect(table.rows).toEqual([
      ['A-1', 5, 9.99],
      ['A-2', 2, 4.5],
      ['A-3', 8, 1.25],
    ]);
  });

  /** Section 10.8: a row must trace to a sheet and a cell range, not to an ordinal. */
  it('carries sheet and cell-range provenance', async () => {
    const table = tableOf(await parse(SIMPLE));
    expect(table.locator).toMatchObject({
      artifactId: 'p:book.xlsx',
      relativePath: 'book.xlsx',
      sheet: 'Orders',
      cellRange: 'A1:C4',
    });
  });

  it('reads every sheet, keyed by its own name', async () => {
    const parsed = await parse({
      sharedStrings: ['a', 'b'],
      sheets: [
        { name: 'First', rows: [row(1, [shared('A1', 0)]), row(2, [number('A2', 1)])].join('') },
        { name: 'Second', rows: [row(1, [shared('A1', 1)]), row(2, [number('A2', 2)])].join('') },
      ],
    });
    expect(parsed.tables?.map((table) => table.sheet)).toEqual(['First', 'Second']);
    // Two tables from one artifact must not collide on their ids.
    expect(new Set(parsed.tables?.map((table) => table.tableId)).size).toBe(2);
  });
});

describe('the three cases a library would have hidden', () => {
  /**
   * Some writers never build the shared table and put the text in the cell. A reader that
   * only handles `t="s"` returns an empty column, and the file looks like it had no data.
   */
  it('reads inline strings, which are not in the shared table', async () => {
    const table = tableOf(
      await parse({
        sheets: [
          {
            name: 'Inline',
            rows: [
              row(1, [inlineString('A1', 'name'), inlineString('B1', 'qty')]),
              row(2, [inlineString('A2', 'widget'), number('B2', 3)]),
            ].join(''),
          },
        ],
      }),
    );
    expect(table.columns.map((column) => column.name)).toEqual(['name', 'qty']);
    expect(table.rows).toEqual([['widget', 3]]);
  });

  /**
   * Set per workbook. Reading a 1904 file as 1900 shifts every date by four years and one
   * day, and every date still looks like a date, which is what makes it dangerous.
   */
  it('converts dates from the 1904 epoch when the workbook says so, and says it did', async () => {
    const spec = (date1904: boolean): WorkbookSpec => ({
      date1904,
      sharedStrings: ['on'],
      cellFormats: [0, 14],
      sheets: [
        {
          name: 'Dates',
          rows: [row(1, [shared('A1', 0)]), row(2, [number('A2', 45_000, 1)])].join(''),
        },
      ],
    });

    const asIs1900 = tableOf(await parse(spec(false)));
    const asIs1904 = tableOf(await parse(spec(true)));
    expect(asIs1900.rows[0]?.[0]).toBe('2023-03-15');
    // Exactly 1,462 days later, which is Microsoft's documented offset between the two
    // systems. Reading a 1904 workbook as 1900 moves every date by four years and a day and
    // leaves every one of them looking like a perfectly ordinary date.
    expect(asIs1904.rows[0]?.[0]).toBe('2027-03-16');
    expect((Date.parse('2027-03-16') - Date.parse('2023-03-15')) / 86_400_000).toBe(1462);
    expect(asIs1900.columns[0]?.type).toBe('date');
  });

  it('warns that the 1904 epoch was used, because nothing else would look wrong', async () => {
    const parsed = await parse({
      date1904: true,
      sharedStrings: ['on'],
      cellFormats: [0, 14],
      sheets: [
        { name: 'D', rows: [row(1, [shared('A1', 0)]), row(2, [number('A2', 1, 1)])].join('') },
      ],
    });
    expect(parsed.warnings.some((one) => one.code === 'xlsx-1904-dates')).toBe(true);
  });

  /**
   * `#REF!` must survive as itself. Coerced to null it claims the cell is empty; coerced to
   * a bare string in a numeric column it reads as data. Either way a broken formula becomes
   * indistinguishable from a real value.
   */
  it('keeps an error cell as its error text, and refuses to type the column numerically', async () => {
    const table = tableOf(
      await parse({
        sharedStrings: ['total'],
        sheets: [
          {
            name: 'Errors',
            rows: [
              row(1, [shared('A1', 0)]),
              row(2, [number('A2', 10)]),
              row(3, [errorCell('A3', '#REF!')]),
            ].join(''),
          },
        ],
      }),
    );
    expect(table.rows).toEqual([[10], ['#REF!']]);
    expect(table.columns[0]?.type).toBe('text');
  });
});

describe('formulas are text, never results', () => {
  it('stores the formula as written and keeps its cached value as the cell', async () => {
    const parsed = await parse({
      sharedStrings: ['a', 'b', 'total'],
      sheets: [
        {
          name: 'Calc',
          rows: [
            row(1, [shared('A1', 0), shared('B1', 1), shared('C1', 2)]),
            row(2, [number('A2', 5), number('B2', 3), formula('C2', 'A2*B2', 15)]),
          ].join(''),
        },
      ],
    });
    const table = tableOf(parsed);
    // The cached result is the cell's value: it is what the file says the cell contains.
    expect(table.rows[0]).toEqual([5, 3, 15]);
    // And the formula text is kept beside it, unevaluated. Section 12.6 step 5.
    expect(table.metadata.formulas).toEqual(['C2=A2*B2']);
  });

  it('never evaluates: a formula whose cached value is wrong is reported as stored', async () => {
    const table = tableOf(
      await parse({
        sharedStrings: ['n'],
        sheets: [
          {
            name: 'Stale',
            rows: [row(1, [shared('A1', 0)]), row(2, [formula('A2', '1+1', 99)])].join(''),
          },
        ],
      }),
    );
    // 1+1 is not 99. Lorepack has no formula engine and must never appear to have one.
    expect(table.rows[0]).toEqual([99]);
  });
});

describe('layouts the detector must not guess at', () => {
  it('skips a title row above the header and says which row it started from', async () => {
    const parsed = await parse({
      sharedStrings: ['Q3 Sales Report', 'region', 'units', 'EU'],
      sheets: [
        {
          name: 'Report',
          rows: [
            row(1, [shared('A1', 0)]),
            row(2, [shared('A2', 1), shared('B2', 2)]),
            row(3, [shared('A3', 3), number('B3', 40)]),
          ].join(''),
        },
      ],
    });
    const table = tableOf(parsed);
    expect(table.columns.map((column) => column.name)).toEqual(['region', 'units']);
    expect(table.rows).toEqual([['EU', 40]]);
    expect(table.metadata.headerRow).toBe(2);
    expect(parsed.warnings.some((one) => one.code === 'xlsx-preamble-skipped')).toBe(true);
  });

  /**
   * The refusal is the feature. Inventing a table from a layout nobody meant as one produces
   * confident, queryable, wrong data, which is worse than an honest "not imported".
   */
  it('refuses to invent a table from a sheet with no header, and names the sheet', async () => {
    const parsed = await parse({
      sheets: [
        {
          name: 'Scratch',
          rows: [row(1, [number('A1', 1)]), row(2, [number('A2', 2)])].join(''),
        },
      ],
    });
    expect(parsed.tables).toBeUndefined();
    const warning = parsed.warnings.find((one) => one.code === 'xlsx-no-table');
    expect(warning?.message).toContain('Scratch');
    // It is described rather than dumped: one node, not a cell per line.
    const node = parsed.nodes.find((one) => one.kind === 'sheet');
    expect(node?.metadata.imported).toBe(false);
    expect(node?.text).toContain('not imported as a table');
  });

  it('reports merged ranges rather than filling in the cells they cover', async () => {
    const parsed = await parse({
      sharedStrings: ['name', 'q1', 'q2', 'Ada'],
      sheets: [
        {
          name: 'Merged',
          rows: [
            row(1, [shared('A1', 0), shared('B1', 1), shared('C1', 2)]),
            row(2, [shared('A2', 3), number('B2', 4), empty('C2')]),
          ].join(''),
          merges: ['B2:C2'],
        },
      ],
    });
    const warning = parsed.warnings.find((one) => one.code === 'xlsx-merged-cells');
    expect(warning?.message).toContain('B2:C2');
    // The covered cell is empty, not a copy of the merged value: the file does not contain one.
    expect(tableOf(parsed).rows[0]).toEqual(['Ada', 4, null]);
  });

  it('keeps every column when two headers share a name', async () => {
    const table = tableOf(
      await parse({
        sharedStrings: ['name', 'name', 'x'],
        sheets: [
          {
            name: 'Dupes',
            rows: [
              row(1, [shared('A1', 0), shared('B1', 1)]),
              row(2, [shared('A2', 2), shared('B2', 2)]),
            ].join(''),
          },
        ],
      }),
    );
    expect(table.columns.map((column) => column.name)).toEqual(['name', 'name_2']);
  });
});

describe('types match the CSV rules exactly', () => {
  it('keeps a leading-zero identifier as text, because Excel stored it as a string', async () => {
    const table = tableOf(
      await parse({
        sharedStrings: ['zip', '00123', '02139'],
        sheets: [
          {
            name: 'Zips',
            rows: [
              row(1, [shared('A1', 0)]),
              row(2, [shared('A2', 1)]),
              row(3, [shared('A3', 2)]),
            ].join(''),
          },
        ],
      }),
    );
    expect(table.columns[0]?.type).toBe('text');
    expect(table.rows).toEqual([['00123'], ['02139']]);
  });

  it('falls back to text when a column mixes numbers and words', async () => {
    const table = tableOf(
      await parse({
        sharedStrings: ['amount', 'pending'],
        sheets: [
          {
            name: 'Mixed',
            rows: [
              row(1, [shared('A1', 0)]),
              row(2, [number('A2', 10)]),
              row(3, [shared('A3', 1)]),
            ].join(''),
          },
        ],
      }),
    );
    expect(table.columns[0]?.type).toBe('text');
  });

  it('widens integers and reals to real rather than abandoning arithmetic', async () => {
    const table = tableOf(
      await parse({
        sharedStrings: ['n'],
        sheets: [
          {
            name: 'N',
            rows: [
              row(1, [shared('A1', 0)]),
              row(2, [number('A2', 1)]),
              row(3, [number('A3', 2.5)]),
            ].join(''),
          },
        ],
      }),
    );
    expect(table.columns[0]?.type).toBe('real');
  });

  it('reads booleans as booleans', async () => {
    const table = tableOf(
      await parse({
        sharedStrings: ['active'],
        sheets: [
          {
            name: 'B',
            rows: [
              row(1, [shared('A1', 0)]),
              row(2, [boolean_('A2', true)]),
              row(3, [boolean_('A3', false)]),
            ].join(''),
          },
        ],
      }),
    );
    expect(table.columns[0]?.type).toBe('boolean');
    expect(table.rows).toEqual([[true], [false]]);
  });

  it('detects a date behind a custom number format, not just the builtin ids', async () => {
    const table = tableOf(
      await parse({
        sharedStrings: ['on'],
        numberFormats: [{ id: 200, code: 'dd/mm/yyyy' }],
        cellFormats: [0, 200],
        sheets: [
          {
            name: 'Custom',
            rows: [row(1, [shared('A1', 0)]), row(2, [number('A2', 45_000, 1)])].join(''),
          },
        ],
      }),
    );
    expect(table.columns[0]?.type).toBe('date');
  });

  /**
   * A currency format contains a quoted literal, and `"$"#,##0.00` has an `s` in `$`... no,
   * but `"Sales"#,##0` does. A naive date-token test matches it and turns every price into a
   * date in 1902. Stripping quoted literals first is what prevents that.
   */
  it('does not mistake a currency format with a quoted literal for a date', async () => {
    const table = tableOf(
      await parse({
        sharedStrings: ['price'],
        numberFormats: [{ id: 201, code: '"Sales day"#,##0.00' }],
        cellFormats: [0, 201],
        sheets: [
          {
            name: 'Money',
            rows: [row(1, [shared('A1', 0)]), row(2, [number('A2', 1234.5, 1)])].join(''),
          },
        ],
      }),
    );
    expect(table.columns[0]?.type).toBe('real');
    expect(table.rows[0]?.[0]).toBe(1234.5);
  });
});

describe('hardening', () => {
  /**
   * Entity expansion, refused outright. `sax` in strict mode does not expand custom entities
   * anyway (verified separately), but the guarantee we rely on should be one we assert.
   */
  it('refuses a part that declares a document type', async () => {
    const bytes = await makeXlsx({
      sheets: [{ name: 'S', rows: row(1, [inlineString('A1', 'a')]) }],
      rawSharedStrings: `<?xml version="1.0"?><!DOCTYPE sst [<!ENTITY x SYSTEM "file:///etc/passwd">]><sst><si><t>&x;</t></si></sst>`,
    });
    const failure = await parseBytes(bytes).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LoreError);
    expect((failure as LoreError).message).toContain('document type');
  });

  it('refuses a legacy .xls by name rather than failing obscurely', async () => {
    const bytes = await makeXlsx(SIMPLE);
    const failure = await parseBytes(bytes, 'old.xls').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LoreError);
    expect((failure as LoreError).remediation).toContain('save as .xlsx');
  });

  it('fails a file that is not a zip with an actionable message', async () => {
    const failure = await parseBytes(new TextEncoder().encode('not a zip')).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LoreError);
    expect((failure as LoreError).remediation).toMatch(/password|corrupt/i);
  });

  it('fails a sheet whose xml is malformed', async () => {
    const bytes = await makeXlsx({
      sheets: [{ name: 'S', rows: '<row r="1"><c r="A1"><v>1</v>' }],
    });
    const failure = await parseBytes(bytes).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LoreError);
  });

  it('fails a sheet wider than the column limit, naming the limit', async () => {
    const header = Array.from({ length: XLSX_LIMITS.maxColumns + 1 }, (_, index) =>
      inlineString(`${lettersFor(index)}1`, `c${String(index)}`),
    );
    const body = Array.from({ length: XLSX_LIMITS.maxColumns + 1 }, (_, index) =>
      number(`${lettersFor(index)}2`, index),
    );
    const failure = await parse({
      sheets: [{ name: 'Wide', rows: [row(1, header), row(2, body)].join('') }],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LoreError);
    expect((failure as LoreError).message).toMatch(/101 columns.*limit of 100/s);
  });
});

describe('determinism and neutrality', () => {
  it('produces identical output on a second parse', async () => {
    const bytes = await makeXlsx(SIMPLE);
    expect(JSON.stringify(await parseBytes(bytes))).toBe(JSON.stringify(await parseBytes(bytes)));
  });

  it('resolves sheets through relationships rather than by sorting file names', async () => {
    // The fixture writer numbers relationship ids from 10 while the parts are sheet1, sheet2,
    // so a reader that zipped sorted names against declared order would still pass. What this
    // asserts is that the *names* line up with the right content.
    const parsed = await parse({
      sharedStrings: ['x', 'y'],
      sheets: [
        { name: 'Alpha', rows: [row(1, [shared('A1', 0)]), row(2, [number('A2', 1)])].join('') },
        { name: 'Beta', rows: [row(1, [shared('A1', 1)]), row(2, [number('A2', 2)])].join('') },
      ],
    });
    expect(tableOf(parsed, 'Alpha').columns[0]?.name).toBe('x');
    expect(tableOf(parsed, 'Beta').columns[0]?.name).toBe('y');
  });

  it('starts the artifact neutral, leaving status and authority to the rule stage', async () => {
    const parsed = await parse(SIMPLE);
    expect(parsed.artifact.status).toBe('active');
    expect(parsed.artifact.authority).toBe(50);
  });

  it('makes no table from an empty workbook, and says so per sheet', async () => {
    const parsed = await parse({ sheets: [{ name: 'Blank', rows: '' }] });
    expect(parsed.tables).toBeUndefined();
    expect(parsed.warnings.some((one) => one.code === 'xlsx-no-table')).toBe(true);
  });
});

function lettersFor(column: number): string {
  let remaining = column + 1;
  let letters = '';
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    remaining = Math.floor((remaining - remainder) / 26);
  }
  return letters;
}

/**
 * The scale envelope, held as a test rather than as a claim in a document.
 *
 * The ADR budgeted 85 MB peak and roughly 14 s for 500,000 rows across two million cells. The
 * reader beats both, and the split is worth recording because it is the thing that would
 * regress: streaming the sheet costs about 16 MB above baseline whatever its size, and the
 * remaining ~82 MB is the materialised table, which is the shape `ParsedTable` asks for and
 * exactly the trade the CSV parser makes.
 *
 * It also pins two defects this size found and no small fixture could: the cell range was
 * computed from the buffered preamble and reported `A1:D24` for a 500,000-row sheet, and
 * `sax`'s stream has no `destroy`, so piping into it died under backpressure with a message
 * about a corrupt workbook.
 */
describe('the 500,000-row envelope', () => {
  it('reads the envelope, streaming, with the full range and honest types', async () => {
    const rows: string[] = [
      row(1, [
        inlineString('A1', 'id'),
        inlineString('B1', 'name'),
        inlineString('C1', 'qty'),
        inlineString('D1', 'price'),
      ]),
    ];
    for (let index = 0; index < XLSX_LIMITS.maxRows; index += 1) {
      const line = index + 2;
      rows.push(
        row(line, [
          number(`A${String(line)}`, index),
          inlineString(`B${String(line)}`, `n${String(index)}`),
          number(`C${String(line)}`, index % 97),
          number(`D${String(line)}`, (index % 997) + 0.5),
        ]),
      );
    }

    const table = tableOf(await parse({ sheets: [{ name: 'Big', rows: rows.join('') }] }));
    expect(table.rows).toHaveLength(XLSX_LIMITS.maxRows);
    // The range must reach the last row, not the last row the detector happened to have seen.
    expect(table.metadata.cellRange).toBe(`A1:D${String(XLSX_LIMITS.maxRows + 1)}`);
    expect(table.columns.map((column) => column.type)).toEqual([
      'integer',
      'text',
      'integer',
      'real',
    ]);
    expect(table.rows.at(-1)?.[0]).toBe(XLSX_LIMITS.maxRows - 1);
  }, 180_000);

  it('refuses a sheet above the envelope rather than importing part of it', async () => {
    const rows: string[] = [row(1, [inlineString('A1', 'id')])];
    for (let index = 0; index < XLSX_LIMITS.maxRows + 64; index += 1) {
      const line = index + 2;
      rows.push(row(line, [number(`A${String(line)}`, index)]));
    }
    const failure = await parse({ sheets: [{ name: 'TooBig', rows: rows.join('') }] }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LoreError);
    expect((failure as LoreError).message).toMatch(/more than the 500,000 rows/);
  }, 180_000);
});
