import { hashBytes, type ParsedArtifact, type ParsedTable, type ParseInput } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import { CSV_LIMITS, csvParser } from '../src/csv/parser.js';

/**
 * CSV, where the tests that matter are the ones about what is *not* done.
 *
 * Almost every assertion here is a refusal: this value was not coerced, this column was not
 * dropped, this row was not silently repaired. That is the shape of architecture section
 * 12.6, and it is the shape of the bugs that would be unrecoverable if they shipped, because
 * a build that discarded a leading zero cannot be asked for it later.
 */

function parse(csv: string, relativePath = 'data.csv'): ParsedArtifact {
  const bytes = new TextEncoder().encode(csv);
  const input: ParseInput = {
    artifactId: `p:${relativePath}`,
    sourceId: 'p',
    relativePath,
    displayPath: relativePath,
    mediaType: 'text/csv',
    byteSize: bytes.byteLength,
    contentHash: hashBytes(bytes),
    bytes,
  };
  return csvParser.parse(input) as ParsedArtifact;
}

const tableOf = (parsed: ParsedArtifact): ParsedTable => {
  const table = parsed.tables?.[0];
  if (table === undefined) throw new Error('expected a table');
  return table;
};
const typeOf = (parsed: ParsedArtifact, column: string): string | undefined =>
  tableOf(parsed).columns.find((one) => one.name === column)?.type;
const columnValues = (parsed: ParsedArtifact, column: string): unknown[] => {
  const table = tableOf(parsed);
  const index = table.columns.findIndex((one) => one.name === column);
  return table.rows.map((row) => row[index]);
};

describe('identifiers are never coerced into numbers', () => {
  /**
   * The headline property. A postal code read as an integer comes back as `123` and the
   * original is gone: no query, no rebuild and no later fix can recover it, because the
   * information left the system at import time.
   */
  it('keeps a leading zero as text', () => {
    const parsed = parse('zip,city\n00123,Springfield\n02139,Cambridge\n');
    expect(typeOf(parsed, 'zip')).toBe('text');
    expect(columnValues(parsed, 'zip')).toEqual(['00123', '02139']);
  });

  it('keeps a phone number with a country prefix as text', () => {
    const parsed = parse('phone\n+441632960000\n+441632960001\n');
    expect(typeOf(parsed, 'phone')).toBe('text');
    expect(columnValues(parsed, 'phone')[0]).toBe('+441632960000');
  });

  /**
   * Nineteen-digit ids are the most common column that silently corrupts. `9007199254740993`
   * parses to a double and comes back off by one, with no error anywhere.
   */
  it('keeps an id beyond safe-integer range as text', () => {
    const parsed = parse('id\n9007199254740993\n9007199254740995\n');
    expect(typeOf(parsed, 'id')).toBe('text');
    expect(columnValues(parsed, 'id')).toEqual(['9007199254740993', '9007199254740995']);
  });

  it('falls back to text when one value in a numeric column disagrees', () => {
    const parsed = parse('amount\n10\n20\nn/a-pending\n');
    expect(typeOf(parsed, 'amount')).toBe('text');
    expect(columnValues(parsed, 'amount')).toEqual(['10', '20', 'n/a-pending']);
  });

  it('does coerce an ordinary integer column, which is the point of inferring at all', () => {
    const parsed = parse('count\n1\n2\n30\n');
    expect(typeOf(parsed, 'count')).toBe('integer');
    expect(columnValues(parsed, 'count')).toEqual([1, 2, 30]);
  });
});

describe('dates are inferred only when they are unambiguous', () => {
  it('reads an ISO date', () => {
    const parsed = parse('on\n2026-01-31\n2026-02-01\n');
    expect(typeOf(parsed, 'on')).toBe('date');
  });

  /**
   * `03/04/2026` is March the fourth in one country and April the third in another, and the
   * file never says which. A date column that is wrong for half the world and looks right to
   * everyone is worse than a text column that is right for all of it.
   */
  it('refuses a slash-separated date, whichever way it might be read', () => {
    const parsed = parse('on\n03/04/2026\n05/06/2026\n');
    expect(typeOf(parsed, 'on')).toBe('text');
  });

  it('refuses a date that matches the shape but cannot exist', () => {
    const parsed = parse('on\n2026-02-30\n2026-01-01\n');
    expect(typeOf(parsed, 'on')).toBe('text');
  });
});

describe('headers', () => {
  it('keeps every column when two share a name, and says so', () => {
    const parsed = parse('name,name,age\na,b,30\n');
    expect(tableOf(parsed).columns.map((column) => column.name)).toEqual(['name', 'name_2', 'age']);
    // The failure this guards against is real: csv-parse's own `columns: true` returns one
    // column here and lets the second value win, which loses a column of user data silently.
    expect(tableOf(parsed).rows[0]).toEqual(['a', 'b', 30]);
    expect(parsed.warnings.some((one) => one.code === 'csv-duplicate-header')).toBe(true);
  });

  it('synthesizes names when row one is data, and records the decision', () => {
    const parsed = parse('1,2\n3,4\n');
    expect(tableOf(parsed).columns.map((column) => column.name)).toEqual(['column_1', 'column_2']);
    expect(tableOf(parsed).metadata.hasHeader).toBe(false);
    expect(String(tableOf(parsed).metadata.headerReason)).toContain('data');
    // Row one is data, so it is a row. Treating it as a header would delete it.
    expect(tableOf(parsed).rows).toHaveLength(2);
  });
});

describe('dialect', () => {
  it('detects a semicolon file whose text contains more commas', () => {
    const parsed = parse('name;note\nA;"one, two, three"\nB;"four, five, six"\n');
    expect(tableOf(parsed).metadata.delimiter).toBe(';');
    expect(tableOf(parsed).columns.map((column) => column.name)).toEqual(['name', 'note']);
  });

  it('reads a tab file by its extension', () => {
    const parsed = parse('a\tb\n1\t2\n', 'data.tsv');
    expect(tableOf(parsed).metadata.delimiter).toBe('\t');
  });

  it('strips a byte order mark instead of pasting it onto column one', () => {
    const parsed = parse('﻿name,age\nA,30\n');
    expect(tableOf(parsed).columns[0]?.name).toBe('name');
  });

  it('reads CRLF line endings', () => {
    const parsed = parse('a,b\r\n1,2\r\n');
    expect(tableOf(parsed).rows).toEqual([[1, 2]]);
  });

  it('keeps a quoted field containing the delimiter and a newline as one value', () => {
    const parsed = parse('a,b\n"x,y","line1\nline2"\n');
    expect(tableOf(parsed).rows[0]).toEqual(['x,y', 'line1\nline2']);
  });
});

describe('nothing is dropped silently', () => {
  it('warns about ragged rows with their line numbers and keeps every cell', () => {
    const parsed = parse('a,b,c\n1,2,3\n4,5\n6,7,8\n');
    const warning = parsed.warnings.find((one) => one.code === 'csv-ragged-row');
    expect(warning?.message).toContain('3');
    // The short row's missing cell is null, and the rows around it are untouched.
    expect(tableOf(parsed).rows[1]).toEqual([4, 5, null]);
  });

  /**
   * A body row wider than the header means the file has a column the header forgot to name,
   * and its data is real. Sizing the table from the header would delete it.
   */
  it('keeps a column the header did not name', () => {
    const parsed = parse('a,b\n1,2,3\n');
    expect(tableOf(parsed).columns).toHaveLength(3);
    expect(tableOf(parsed).rows[0]).toEqual([1, 2, 3]);
  });

  it('widens a column and says so when a late row breaks the sampled type', () => {
    const rows = Array.from({ length: CSV_LIMITS.inferenceSampleRows }, (_, i) => String(i));
    const parsed = parse(`v\n${rows.join('\n')}\nnot-a-number\n`);
    expect(typeOf(parsed, 'v')).toBe('text');
    expect(parsed.warnings.some((one) => one.code === 'csv-type-widened')).toBe(true);
    // Widened, not discarded. The value that broke the type is still in the table.
    expect(columnValues(parsed, 'v').at(-1)).toBe('not-a-number');
  });
});

describe('the table is described, never flattened into prose', () => {
  /**
   * Section 4.6 calls a workbook rendered as a block of text an invalid implementation. The
   * structural guarantee is that row count does not drive node count: a hundred rows and
   * three rows produce the same two nodes.
   */
  it('emits one document and one table node however many rows there are', () => {
    const small = parse('a,b\n1,2\n');
    const large = parse(`a,b\n${Array.from({ length: 500 }, (_, i) => `${i},${i}`).join('\n')}\n`);
    expect(small.nodes.map((node) => node.kind)).toEqual(['document', 'table']);
    expect(large.nodes.map((node) => node.kind)).toEqual(['document', 'table']);
  });

  it('names the columns in the retrieval node, so a search for them finds the table', () => {
    const parsed = parse('region,shipping_cost\nEU,4.5\n');
    const node = parsed.nodes.find((one) => one.kind === 'table');
    expect(node?.text).toContain('region');
    expect(node?.text).toContain('shipping_cost');
    expect(node?.metadata.tableId).toBe(tableOf(parsed).tableId);
  });

  it('carries a locator with the file and its line range', () => {
    const parsed = parse('a\n1\n2\n');
    expect(tableOf(parsed).locator).toMatchObject({
      artifactId: 'p:data.csv',
      relativePath: 'data.csv',
      lineStart: 1,
      lineEnd: 3,
    });
  });
});

describe('statistics', () => {
  it('counts nulls and distinct values per column', () => {
    const parsed = parse('a,b\n1,x\n,x\n3,y\n');
    const table = tableOf(parsed);
    const a = table.columns[0];
    const b = table.columns[1];
    expect(a?.statistics.nullCount).toBe(1);
    expect(a?.nullable).toBe(true);
    expect(b?.statistics.distinctEstimate).toBe(2);
    expect(b?.statistics.distinctIsExact).toBe(true);
    expect(b?.nullable).toBe(false);
  });

  it('reports min and max numerically for a numeric column', () => {
    const parsed = parse('n\n10\n9\n100\n');
    // Numeric, not lexical: `9` is the maximum only if these are compared as strings.
    expect(tableOf(parsed).columns[0]?.statistics).toMatchObject({ min: 9, max: 100 });
  });
});

describe('limits and refusals', () => {
  it('fails a table wider than the supported column count, naming the limit', () => {
    const header = Array.from({ length: CSV_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(',');
    expect(() => parse(`${header}\n`)).toThrowError(/101 columns.*limit of 100/s);
  });

  it('makes no table from an empty file, and says why', () => {
    const parsed = parse('');
    expect(parsed.tables).toBeUndefined();
    expect(parsed.warnings.some((one) => one.code === 'empty-file')).toBe(true);
  });
});

describe('determinism', () => {
  it('produces identical output on a second parse', () => {
    const csv = 'zip,amount,on\n00123,4.5,2026-01-01\n00124,6.5,2026-01-02\n';
    expect(JSON.stringify(parse(csv))).toBe(JSON.stringify(parse(csv)));
  });

  it('starts the artifact neutral, leaving status and authority to the rule stage', () => {
    const parsed = parse('a\n1\n');
    expect(parsed.artifact.status).toBe('active');
    expect(parsed.artifact.authority).toBe(50);
  });
});

/**
 * The scale envelope, as a real test rather than a note in a document.
 *
 * This one earned its place: it caught `RangeError: Maximum call stack size exceeded` from a
 * `Math.max(...rows)` spread that every unit test above passed straight through, because the
 * failure only exists above about a hundred thousand rows. A limit that is only ever asserted
 * in prose is a limit nobody has checked.
 */
describe('the 500,000-row envelope', () => {
  it('parses the envelope without exhausting the stack, and types it honestly', () => {
    const rows: string[] = ['id,zip,amount'];
    for (let index = 0; index < CSV_LIMITS.maxRows; index += 1) {
      rows.push(`${index},${String(index % 100_000).padStart(5, '0')},${(index % 997) + 0.5}`);
    }
    const parsed = parse(`${rows.join('\n')}\n`);
    const table = tableOf(parsed);

    expect(table.rows).toHaveLength(CSV_LIMITS.maxRows);
    // Typed from a 1,000-row sample and still correct at row 500,000: the identifier column
    // is text because its first value has leading zeros, and the amounts are real.
    expect(table.columns.map((column) => column.type)).toEqual(['integer', 'text', 'real']);
    expect(table.rows[0]?.[1]).toBe('00000');
    expect(table.rows.at(-1)?.[1]).toBe('99999');
  }, 60_000);

  it('refuses a file above the envelope rather than importing part of it', () => {
    const rows: string[] = ['id'];
    for (let index = 0; index <= CSV_LIMITS.maxRows; index += 1) rows.push(String(index));
    expect(() => parse(`${rows.join('\n')}\n`)).toThrowError(/above the supported limit/);
  }, 60_000);
});
