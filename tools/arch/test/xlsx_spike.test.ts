import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boolean_,
  empty,
  formula,
  makeXlsx,
  number,
  row,
  shared,
  type WorkbookSpec,
} from '../../test-support/src/office-fixtures.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const WORKBOOK: WorkbookSpec = {
  sharedStrings: ['Roadmap'],
  cellFormats: [0, 14, 164],
  numberFormats: [{ id: 164, code: 'yyyy-mm-dd' }],
  sheets: [
    {
      name: 'Overview',
      rows:
        row(1, [
          shared('A1', 0),
          number('B1', 4),
          boolean_('C1', true),
          empty('D1'),
          formula('E1', 'B1*2', 8),
          formula('F1', '"cached"', 'cached', 'str'),
          number('G1', 45292, 1),
          number('H1', 45293, 2),
        ]) +
        row(
          2,
          'ABCDEFGH'.split('').map((column, index) => number(`${column}2`, index + 10)),
        ),
      merges: ['A1:B1'],
    },
    { name: 'Data', rows: row(1, [number('A1', 101), boolean_('B1', false)]) },
  ],
};

async function execute(spec: WorkbookSpec | string, sheet?: string, implicitPath = false) {
  const directory = mkdtempSync(join(tmpdir(), 'lorepack-xlsx-spike-'));
  try {
    const path = join(directory, 'fixture-small.xlsx');
    writeFileSync(path, typeof spec === 'string' ? spec : await makeXlsx(spec));
    return spawnSync(
      process.execPath,
      [
        join(ROOT, 'benchmarks/xlsx/spike-own-reader.mjs'),
        ...(implicitPath ? [] : [path]),
        ...(sheet === undefined ? [] : [sheet]),
      ],
      { cwd: directory, encoding: 'utf8' },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the existing XLSX reader spike command', () => {
  it('reads typed cells, formulas and merges from the default workbook path', async () => {
    const result = await execute(WORKBOOK, undefined, true);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      file: 'fixture-small.xlsx',
      sheet: 'Overview',
      sheetNames: ['Overview', 'Data'],
      rows: 2,
      cells: 16,
      formulas: 2,
      merges: ['A1:B1'],
    });
    expect(report.sample).toHaveLength(12);
    expect(report.sample).toEqual(
      expect.arrayContaining([
        'A1=string:"Roadmap"',
        'B1=number:4',
        'C1=boolean:true',
        'D1=empty:null',
        'E1=number:8 F:B1*2',
        'F1=string:"cached" F:"cached"',
        'G1=date:"2024-01-01"',
        'H1=date:"2024-01-02"',
      ]),
    );
  });

  it('selects the requested sheet while retaining workbook order', async () => {
    const result = await execute(WORKBOOK, 'Data');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      sheet: 'Data',
      sheetNames: ['Overview', 'Data'],
      rows: 1,
      cells: 2,
      formulas: 0,
      merges: [],
      sample: ['A1=number:101', 'B1=boolean:false'],
    });
  });

  it('refuses malformed archive bytes without emitting a report', async () => {
    const result = await execute('This is not an XLSX archive.');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/central directory|zipfile/i);
  });

  it('refuses a DTD in the shared-string part', async () => {
    const result = await execute({
      ...WORKBOOK,
      rawSharedStrings: '<!DOCTYPE sst><sst><si><t>Roadmap</t></si></sst>',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('DTD refused');
  });
});
