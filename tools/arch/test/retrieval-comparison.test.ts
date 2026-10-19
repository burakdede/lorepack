import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAt, writeProject } from '../../../scripts/bench-corpus.mjs';
import { validateBenchmarkReport } from '../../../scripts/benchmark-report.mjs';

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
    lorepack: Record<string, unknown>;
    sqliteFts5: Record<string, unknown>;
  };
  baselines: {
    lorepack: { contextBundleMs: { p95: number } };
    sqliteFts5: { contextBundleMs: null; contextUnsupportedReason: string };
  };
};

describe('retrieval comparison contract', () => {
  it('runs the actual comparison controller and persists its complete shared-workload report', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lore-comparison-contract-'));
    const output = join(directory, 'nested', 'comparison.json');
    try {
      const execution = spawnSync(
        process.execPath,
        [join(root, 'scripts/bench-retrieval-comparison.mjs'), '--out', output],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            LORE_BENCH_PACKS: '1',
            LORE_BENCH_SCALE: 'small',
            LORE_BENCH_PROFILE: 'mixed',
            LORE_BENCH_STORAGE_CLASS: 'fixture-not-reference',
          },
        },
      );
      expect(execution.status, execution.stderr).toBe(0);
      expect(execution.stdout).toContain(`Wrote ${output}\n`);
      const text = readFileSync(output, 'utf8');
      expect(execution.stdout.slice(execution.stdout.indexOf('\n') + 1)).toBe(`${text}\n`);
      const current = JSON.parse(text);
      expect(current).toMatchObject({
        protocol: { name: 'lorepack-benchmark-comparison', version: 1 },
        provisional: true,
        reportedNotEnforced: true,
        corpus: { packs: 1 },
        samples: { build: 3, index: 3, warmSearch: 30, contextBundle: 20 },
      });
      const lorepack = current.protocolReports.lorepack;
      const baseline = current.protocolReports.sqliteFts5;
      expect(validateBenchmarkReport(lorepack)).toEqual([]);
      expect(validateBenchmarkReport(baseline)).toEqual([]);
      expect(lorepack.corpus).toEqual(baseline.corpus);
      expect(lorepack.workload).toEqual(baseline.workload);
      expect(lorepack.commitSha).toBe(current.commitSha);
      expect(baseline.commitSha).toBe(current.commitSha);
      const digest = (path: string) =>
        createHash('sha256')
          .update(readFileSync(join(root, path)))
          .digest('hex');
      expect(lorepack.corpus.manifestSha256).toBe(digest('benchmarks/corpus/manifest.json'));
      expect(lorepack.workload.sha256).toBe(digest('benchmarks/corpus/queries.json'));
      expect(lorepack.environment.storageClass).toBe('fixture-not-reference');
      expect(lorepack.quality.search.cases).toBe(
        workload.qualityQueries.filter((item) => item.kind === 'search').length,
      );
      expect(lorepack.quality.context.cases).toBe(
        workload.qualityQueries.filter((item) => item.kind !== 'search').length,
      );
      expect(lorepack.quality.provenance).toMatchObject({ available: true, coverage: 1 });
      expect(
        lorepack.measurements.phases.map((phase: { name: string; samples: number }) => ({
          name: phase.name,
          samples: phase.samples,
        })),
      ).toEqual([
        { name: 'build', samples: 3 },
        { name: 'cold-query', samples: 1 },
        { name: 'warm-query', samples: 30 },
        { name: 'context-assembly', samples: 20 },
      ]);
      expect(
        baseline.measurements.phases.map((phase: { name: string; samples: number }) => ({
          name: phase.name,
          samples: phase.samples,
        })),
      ).toEqual([
        { name: 'index-build', samples: 3 },
        { name: 'cold-query', samples: 1 },
        { name: 'warm-query', samples: 30 },
      ]);
      expect(current.baselines.sqliteFts5.contextBundleMs).toBeNull();
      expect(current.baselines.sqliteFts5.contextUnsupportedReason).toMatch(/bounded context/i);
      expect(lorepack.claims).toContainEqual(
        expect.objectContaining({ id: 'lorepack-semantic-quality', status: 'not-measured' }),
      );
      expect(lorepack.resources.indexBytes).toBeGreaterThan(0);
      expect(baseline.resources.indexBytes).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 30_000);

  it('runs the direct baseline against an unchanged compiled build', async () => {
    const project = writeProject(1);
    try {
      const built = await buildAt(project.root);
      const database = join(project.root, '.lore', 'builds', built.buildId, 'context.sqlite');
      const before = readFileSync(database);
      const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
      const metadata = {
        commitSha: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
        manifestSha256: sha256(readFileSync(join(root, 'benchmarks/corpus/manifest.json'))),
        workloadSha256: sha256(readFileSync(join(root, 'benchmarks/corpus/queries.json'))),
        scale: 'small',
        profile: 'mixed',
        artifacts: built.counts.artifacts,
        bytes: project.bytes,
        tables: built.counts.tables,
      };
      const stdout = execFileSync(
        process.execPath,
        [
          join(root, 'scripts/bench-retrieval-baseline-worker.mjs'),
          database,
          JSON.stringify(metadata),
        ],
        { cwd: root, encoding: 'utf8' },
      );
      const current = JSON.parse(stdout);
      expect(validateBenchmarkReport(current)).toEqual([]);
      expect(current.commitSha).toBe(metadata.commitSha);
      expect(current.implementation.name).toBe('sqlite-fts5-direct');
      expect(current.corpus).toMatchObject({
        manifestSha256: metadata.manifestSha256,
        scale: 'small',
        profile: 'mixed',
        artifacts: built.counts.artifacts,
        chunks: built.counts.chunks,
        tables: built.counts.tables,
        bytes: project.bytes,
      });
      expect(current.workload).toMatchObject({
        sha256: metadata.workloadSha256,
        queryCount: workload.searchQueries.length,
        contextTaskCount: workload.contextTasks.length,
      });
      expect(current.quality.search.cases).toBe(
        workload.qualityQueries.filter(({ kind }) => kind === 'search').length,
      );
      expect(current.quality.context.status).toBe('not-measured');
      expect(current.tokenAccounting).toEqual({
        status: 'not-applicable',
        tokenizer: null,
        model: null,
        inputTokens: null,
        retrievedContextTokens: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      });
      expect(
        current.measurements.phases.map((phase: { name: string; samples: number }) => ({
          name: phase.name,
          samples: phase.samples,
        })),
      ).toEqual([
        { name: 'index-build', samples: 3 },
        { name: 'cold-query', samples: 1 },
        { name: 'warm-query', samples: 30 },
      ]);
      expect(current.resources.indexBytes).toBeGreaterThan(0);
      expect(readFileSync(database)).toEqual(before);
    } finally {
      rmSync(project.root, { recursive: true, force: true });
    }
  }, 30_000);

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
