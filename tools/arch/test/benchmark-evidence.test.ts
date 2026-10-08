import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURE = join(ROOT, 'benchmarks/evidence/2026-10-08');

describe('benchmark evidence report', () => {
  it('renders a claim ledger from the checked-in raw artifacts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lorepack-evidence-'));
    cpSync(FIXTURE, directory, { recursive: true });
    const output = join(directory, 'rendered.json');

    execFileSync(
      process.execPath,
      ['scripts/render-benchmark-evidence.mjs', directory, '--json', output],
      { cwd: ROOT, stdio: 'pipe' },
    );

    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.protocol).toEqual({ name: 'lorepack-benchmark-evidence', version: 1 });
    expect(report.comparison.lorepack.hitAt1).toBe(1);
    expect(report.comparison.sqliteFts5.hitAt1).toBe(0.8);
    expect(report.comparison.offlineRag.answerQuality).toBe('not-measured');
    expect(report.usefulness.rollback.rebuildAvoided).toBe(true);
    expect(report.usefulness.contextPlacement.matched).toEqual({
      numerator: 15,
      denominator: 15,
      ratio: 1,
    });
    expect(
      report.claims.every((claim: { evidence: Array<{ artifact: string; pointer: string }> }) =>
        claim.evidence.every(
          (evidence) => evidence.artifact.length > 0 && evidence.pointer.startsWith('/'),
        ),
      ),
    ).toBe(true);
  });
});
