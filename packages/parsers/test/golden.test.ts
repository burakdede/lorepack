import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashBytes, type ParsedArtifact, type ParseInput } from '@lorepack/core';
import { compareGolden } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { FORMATS, formatFor } from '../src/registry.js';
import { parserFor } from '../src/registry-parsers.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const FIXTURES = [
  { parserId: 'markdown', path: 'markdown/product-strategy.md' },
  { parserId: 'html', path: 'html/documentation-page.html' },
  { parserId: 'text', path: 'text/operations.txt' },
  { parserId: 'code', path: 'code/deployment.ts' },
  { parserId: 'pdf-text', path: 'pdf/release-guide.pdf' },
  { parserId: 'docx', path: 'docx/release-guide.docx' },
  { parserId: 'csv', path: 'csv/pricing.csv' },
  { parserId: 'xlsx', path: 'xlsx/pricing.xlsx' },
] as const;

async function parseFixture(path: string): Promise<ParsedArtifact> {
  const relativePath = `documents/${path}`;
  const bytes = new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', relativePath)));
  const format = formatFor(relativePath);
  if (format === null) throw new Error(`No registered format for ${relativePath}`);
  const input: ParseInput = {
    artifactId: `fixtures:${relativePath}`,
    sourceId: 'fixtures',
    relativePath,
    displayPath: relativePath,
    mediaType: format.mediaType,
    byteSize: bytes.byteLength,
    contentHash: hashBytes(bytes),
    bytes,
  };
  const parser = parserFor(input);
  if (parser === null) throw new Error(`No parser for ${relativePath}`);
  return await parser.parse(input);
}

it('covers every available format ID, including plain text and code', () => {
  expect(new Set(FIXTURES.map((fixture) => fixture.parserId))).toEqual(
    new Set(FORMATS.filter((format) => format.available).map((format) => format.parserId)),
  );
});

describe.each(FIXTURES)('$parserId golden fixtures', ({ parserId, path }) => {
  it('matches the committed expected output', async () => {
    const parsed = await parseFixture(path);
    expect(parsed.artifact.parserId).toBe(parserId);
    expect(parsed.nodes.length).toBeGreaterThan(0);
    const result = compareGolden(
      join(REPO_ROOT, 'fixtures', 'expected', path.replace(/\.[^.]+$/, '.json')),
      {
        artifact: parsed.artifact,
        nodes: parsed.nodes,
        warnings: parsed.warnings,
        ...(parsed.tables === undefined ? {} : { tables: parsed.tables }),
      },
    );
    expect(result.message ?? '', result.path).toBe('');
  });

  it('produces byte-identical output on a second parse', async () => {
    const first = await parseFixture(path);
    const second = await parseFixture(path);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('source fixture landmarks', () => {
  it('keeps the PDF page gap visible instead of renumbering the remaining text', async () => {
    const parsed = await parseFixture('pdf/release-guide.pdf');
    expect(
      parsed.nodes.filter((node) => node.kind === 'paragraph').map((node) => node.locator.page),
    ).toEqual([1, 3]);
    expect(parsed.warnings.map((warning) => warning.code)).toEqual(['pdf-pages-without-text']);
    expect(parsed.warnings[0]).toMatchObject({
      loss: {},
      message: expect.stringContaining('Pages: 2.'),
    });
    expect(parsed.artifact.title).toBe('Release guide');
  });

  it('retains the DOCX heading hierarchy and table text', async () => {
    const parsed = await parseFixture('docx/release-guide.docx');
    expect(
      parsed.nodes.filter((node) => node.kind === 'section').map((node) => node.title),
    ).toEqual(['Release guide', 'Rollback']);
    expect(
      parsed.nodes.find((node) => node.text === 'Ask the owner before activation.')?.locator
        .headingPath,
    ).toEqual(['Release guide', 'Rollback']);
    expect(parsed.nodes.find((node) => node.kind === 'table')?.text).toBe(
      'Step\nOwner\nActivate\nRelease manager',
    );
  });

  it('distinguishes plain paragraphs from code and preserves original code line ranges', async () => {
    const plain = await parseFixture('text/operations.txt');
    expect(plain.nodes.filter((node) => node.kind === 'paragraph')).toHaveLength(2);
    const code = await parseFixture('code/deployment.ts');
    expect(
      code.nodes
        .filter((node) => node.kind === 'code')
        .map((node) => [node.locator.lineStart, node.locator.lineEnd]),
    ).toEqual([
      [1, 3],
      [5, 5],
    ]);
  });

  it('retains typed rows, worksheet identity and the formula with its cached value', async () => {
    const csv = await parseFixture('csv/pricing.csv');
    const xlsx = await parseFixture('xlsx/pricing.xlsx');
    const rows = [
      ['A-1', 12.5, true],
      ['B-2', 8, false],
    ];
    expect(csv.tables).toHaveLength(1);
    expect(csv.tables?.[0]?.rows).toEqual(rows);
    expect(csv.tables?.[0]?.locator).toMatchObject({ lineStart: 1, lineEnd: 3 });
    expect(xlsx.tables?.map((table) => table.sheet)).toEqual(['Products', 'Owners']);
    expect(xlsx.tables?.[0]?.rows).toEqual(rows);
    expect(xlsx.tables?.[0]?.columns.map((column) => column.type)).toEqual([
      'text',
      'real',
      'boolean',
    ]);
    expect(xlsx.tables?.[0]?.locator).toMatchObject({ sheet: 'Products', cellRange: 'A1:C3' });
    expect(xlsx.tables?.[0]?.metadata.formulas).toEqual(['B2=10+2.5']);
    expect(xlsx.tables?.[1]?.rows).toEqual([['Release', 'Ada']]);
  });
});
