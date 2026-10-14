import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateBenchmarkReport } from '../../../scripts/benchmark-report.mjs';
import { redactSecrets } from '../../../scripts/rag-benchmark-security.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('the offline RAG baseline command', () => {
  it('reports retrieval and prompt estimates without inventing model results', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lorepack-offline-rag-report-'));
    try {
      const output = join(directory, 'report.json');
      const stdout = execFileSync(
        process.execPath,
        [join(ROOT, 'scripts/bench-rag.mjs'), '--out', output],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            RAG_BENCH_MODE: 'offline',
            LORE_BENCH_PACKS: '1',
            LORE_BENCH_SCALE: 'small',
            LORE_BENCH_PROFILE: 'mixed',
          },
        },
      );
      const report = JSON.parse(readFileSync(output, 'utf8'));
      expect(JSON.parse(stdout)).toEqual(report);
      expect(validateBenchmarkReport(report)).toEqual([]);
      expect(report.configuration).toMatchObject({
        mode: 'offline',
        provider: 'none',
        model: 'none',
      });
      expect(report.corpus.chunks).toBeGreaterThan(0);
      const manifest = readFileSync(join(ROOT, 'benchmarks/corpus/manifest.json'));
      const workload = readFileSync(join(ROOT, 'benchmarks/corpus/queries.json'));
      expect(report.corpus.manifestSha256).toBe(
        createHash('sha256').update(manifest).digest('hex'),
      );
      expect(report.workload.sha256).toBe(createHash('sha256').update(workload).digest('hex'));
      const queries = (
        JSON.parse(workload.toString()) as { qualityQueries: Array<{ kind: string }> }
      ).qualityQueries;
      expect(report.quality.search.cases).toBe(
        queries.filter(({ kind }) => kind === 'search').length,
      );
      expect(report.quality.context.cases).toBe(
        queries.filter(({ kind }) => kind === 'context').length,
      );
      expect(report.tokenAccounting).toMatchObject({
        status: 'estimated',
        tokenizer: 'rag-estimator-v1',
        model: null,
        completionTokens: null,
      });
      expect(report.tokenAccounting.promptTokens).toBeGreaterThan(0);
      expect(report.tokenAccounting.totalTokens).toBe(report.tokenAccounting.promptTokens);
      expect(report.tokenAccounting.promptTokens).toBeGreaterThanOrEqual(
        report.tokenAccounting.retrievedContextTokens,
      );
      expect(report.costAccounting).toMatchObject({
        status: 'not-applicable',
        inputUsd: null,
        outputUsd: null,
        totalUsd: null,
      });
      expect(report.quality.answer).toMatchObject({
        status: 'not-measured',
        citationCoverage: { numerator: 0, denominator: 0 },
        taskSuccess: { numerator: 0, denominator: 0 },
      });
      expect(report.measurements.phases.map((phase: { name: string }) => phase.name)).not.toContain(
        'model-generation',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('refuses a missing build path before reading any database', () => {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/bench-rag-baseline-worker.mjs')],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('A Lorepack context.sqlite path is required.');
  });

  it('refuses an unsupported mode before opening the build', () => {
    const result = spawnSync(
      process.execPath,
      [
        join(ROOT, 'scripts/bench-rag-baseline-worker.mjs'),
        'absent.sqlite',
        JSON.stringify({ mode: 'unsupported' }),
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unsupported RAG benchmark mode: unsupported');
    expect(result.stderr).not.toContain('unable to open database');
  });
});

describe('RAG benchmark secret handling', () => {
  it('redacts the API key and bearer values from errors', () => {
    const message = redactSecrets(
      'request Bearer secret-token failed: secret-token',
      'secret-token',
    );
    expect(message).not.toContain('secret-token');
    expect(message).toContain('[REDACTED]');
  });

  it('does not alter errors when no secret is configured', () => {
    expect(redactSecrets('provider failed', undefined)).toBe('provider failed');
  });
});
