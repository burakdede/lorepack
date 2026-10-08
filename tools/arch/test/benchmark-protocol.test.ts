import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateBenchmarkReport } from '../../../scripts/benchmark-report.mjs';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const sample = JSON.parse(
  readFileSync(join(REPO_ROOT, 'benchmarks/protocol/sample-report.json'), 'utf8'),
) as Record<string, unknown>;

describe('benchmark protocol', () => {
  it('accepts the checked-in sample report', () => {
    expect(validateBenchmarkReport(sample)).toEqual([]);
  });

  it('rejects a report without reproducibility metadata', () => {
    const report = structuredClone(sample);
    delete (report.environment as Record<string, unknown>).runner;
    delete (report.workload as Record<string, unknown>).sha256;

    const problems = validateBenchmarkReport(report);
    expect(problems).toContain('environment.runner is required');
    expect(problems).toContain('workload.sha256 must be a lowercase SHA-256');
  });

  it('requires explicit null token accounting for non-RAG reports', () => {
    const report = structuredClone(sample);
    const tokens = report.tokenAccounting as Record<string, unknown>;
    delete tokens.totalTokens;

    expect(validateBenchmarkReport(report)).toContain(
      'tokenAccounting.totalTokens is required, use null when not applicable',
    );
  });

  it('rejects a phase whose tail latency is lower than its median', () => {
    const report = structuredClone(sample);
    const measurements = report.measurements as { phases: Array<Record<string, unknown>> };
    measurements.phases[0].p95Ms = 0.5;

    expect(validateBenchmarkReport(report)).toContain(
      'measurements.phases[0].p95Ms must be at least p50Ms',
    );
  });
});
