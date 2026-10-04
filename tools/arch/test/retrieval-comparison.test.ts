import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');
const workload = JSON.parse(readFileSync(join(root, 'benchmarks/corpus/queries.json'), 'utf8')) as {
  searchQueries: string[];
  contextTasks: string[];
  tableQuery: string;
};
const result = JSON.parse(
  readFileSync(join(root, 'benchmarks/comparison/results-2026-10-04.json'), 'utf8'),
) as {
  queryWorkload: string;
  baselines: {
    lorepack: { contextBundleMs: { p95: number } };
    sqliteFts5: { contextBundleMs: null; contextUnsupportedReason: string };
  };
};

describe('retrieval comparison contract', () => {
  it('keeps a non-empty workload and records its shared source', () => {
    expect(workload.searchQueries.length).toBeGreaterThan(0);
    expect(workload.contextTasks.length).toBeGreaterThan(0);
    expect(workload.tableQuery).toContain('<described-sql-name>');
    expect(result.queryWorkload).toBe('benchmarks/corpus/queries.json');
  });

  it('does not describe the index-only baseline as context-equivalent', () => {
    expect(result.baselines.lorepack.contextBundleMs.p95).toBeGreaterThan(0);
    expect(result.baselines.sqliteFts5.contextBundleMs).toBeNull();
    expect(result.baselines.sqliteFts5.contextUnsupportedReason).toMatch(/bounded context/i);
  });
});
