import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateBenchmarkComparison,
  validateBenchmarkReport,
} from '../../../scripts/benchmark-report.mjs';

const root = join(import.meta.dirname, '../../..');
const workload = JSON.parse(readFileSync(join(root, 'benchmarks/corpus/queries.json'), 'utf8')) as {
  searchQueries: string[];
  contextTasks: string[];
  tableQuery: string;
  qualityQueries: Array<{ kind: string }>;
};
const result = JSON.parse(
  readFileSync(join(root, 'benchmarks/comparison/results-2026-10-08.json'), 'utf8'),
) as {
  queryWorkload: string;
  protocolReports: {
    lorepack: Record<string, unknown> & { claims: Array<{ id: string; status: string }> };
    sqliteFts5: Record<string, unknown> & { workload: Record<string, unknown> };
  };
  baselines: {
    lorepack: { contextBundleMs: { p95: number } };
    sqliteFts5: { contextBundleMs: null; contextUnsupportedReason: string };
  };
};

describe('retrieval comparison contract', () => {
  it('validates the comparison report envelope and its shared workload', () => {
    expect(validateBenchmarkComparison(result)).toEqual([]);
  });

  it('rejects a comparison that claims to measure semantic quality', () => {
    const changed = {
      ...result,
      protocolReports: {
        ...result.protocolReports,
        lorepack: {
          ...result.protocolReports.lorepack,
          claims: result.protocolReports.lorepack.claims.map(
            (claim: { id: string; status: string }) =>
              claim.id === 'lorepack-semantic-quality'
                ? { ...claim, status: 'quality-result' }
                : claim,
          ),
        },
      },
    };
    expect(validateBenchmarkComparison(changed)).toContain(
      'lorepack must not claim semantic quality was measured',
    );
  });

  it('rejects implementation reports that use different workloads', () => {
    const changed = {
      ...result,
      protocolReports: {
        ...result.protocolReports,
        sqliteFts5: {
          ...result.protocolReports.sqliteFts5,
          workload: { ...result.protocolReports.sqliteFts5.workload, sha256: '0'.repeat(64) },
        },
      },
    };
    expect(validateBenchmarkComparison(changed)).toContain(
      'protocolReports must use the same workload',
    );
  });

  it('checks the generated comparison artifact before accepting it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lore-benchmark-artifact-'));
    const artifact = join(directory, 'comparison.json');
    const checker = join(root, 'scripts/check-benchmark-artifacts.mjs');
    try {
      writeFileSync(artifact, JSON.stringify(result));
      const accepted = spawnSync(process.execPath, [checker, directory], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain(
        'Validated 2 implementation reports from 1 JSON artifacts.',
      );

      writeFileSync(artifact, JSON.stringify({ ...result, reportedNotEnforced: false }));
      const rejected = spawnSync(process.execPath, [checker, directory], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('reportedNotEnforced must be true');
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('refuses a missing direct-baseline build path', () => {
    const execution = spawnSync(
      process.execPath,
      [join(root, 'scripts/bench-retrieval-baseline-worker.mjs')],
      { cwd: root, encoding: 'utf8' },
    );
    expect(execution.status).toBe(1);
    expect(execution.stdout).toBe('');
    expect(execution.stderr).toContain('A Lorepack context.sqlite path is required.');
  });

  it('keeps a non-empty workload and records its shared source', () => {
    expect(workload.searchQueries.length).toBeGreaterThan(0);
    expect(workload.contextTasks.length).toBeGreaterThan(0);
    expect(workload.tableQuery).toContain('<described-sql-name>');
    expect(result.queryWorkload).toBe('benchmarks/corpus/queries.json');
  });

  it('validates both implementation reports against protocol v1', () => {
    expect(validateBenchmarkReport(result.protocolReports.lorepack)).toEqual([]);
    expect(validateBenchmarkReport(result.protocolReports.sqliteFts5)).toEqual([]);
    expect(result.protocolReports.lorepack.corpus).toEqual(
      result.protocolReports.sqliteFts5.corpus,
    );
    expect(result.protocolReports.lorepack.workload).toEqual(
      result.protocolReports.sqliteFts5.workload,
    );
  });

  it('does not describe the index-only baseline as context-equivalent', () => {
    expect(result.baselines.lorepack.contextBundleMs.p95).toBeGreaterThan(0);
    expect(result.baselines.sqliteFts5.contextBundleMs).toBeNull();
    expect(result.baselines.sqliteFts5.contextUnsupportedReason).toMatch(/bounded context/i);
  });
});
