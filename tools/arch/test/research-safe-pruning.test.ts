import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildBm25fPostings,
  exhaustiveTopK,
  safePrunedTopK,
} from '../../../scripts/research-safe-pruning.mjs';

it('retains exact BM25F scores for repeated Unicode terms and empty fields', () => {
  const postings = buildBm25fPostings([
    { id: 'a', path: 'a', title: 'RÉPÉTÉ RÉPÉTÉ one', heading: null, body: 'répété two two' },
    { id: 'b', path: 'b', title: 'one', heading: '', body: 'two two RÉPÉTÉ RÉPÉTÉ' },
  ]);
  const score = (frequency: number, idf = Math.log(1 + 0.5 / 2.5)) =>
    (idf * (1.2 + 1) * frequency) / (1.2 + frequency);
  const expected = new Map([
    [
      'a',
      new Map([
        ['a', score(4, Math.log(1 + 1.5 / 1.5))],
        ['répété', score(6 * (2 / (1 - 0.2 + 0.2 * (3 / 2))) + 1 / (1 - 0.75 + 0.75 * (3 / 3.5)))],
        ['one', score(6 * (1 / (1 - 0.2 + 0.2 * (3 / 2))))],
        ['two', score(2 / (1 - 0.75 + 0.75 * (3 / 3.5)))],
      ]),
    ],
    [
      'b',
      new Map([
        ['b', score(4, Math.log(1 + 1.5 / 1.5))],
        ['one', score(6 * (1 / (1 - 0.2 + 0.2 * (1 / 2))))],
        ['two', score(2 / (1 - 0.75 + 0.75 * (4 / 3.5)))],
        ['répété', score(6 * (0 / (1 - 0.2 + 0.2 * (1 / 2))) + 2 / (1 - 0.75 + 0.75 * (4 / 3.5)))],
      ]),
    ],
  ]);
  expect(postings).toHaveProperty('documentTermScores', expected);
  expect([...postings.keys()]).toEqual(['a', 'répété', 'one', 'two', 'b']);
  for (const [term, entries] of postings) {
    expect(entries).toEqual(
      [...expected]
        .flatMap(([docId, scores]) => {
          const contribution = scores.get(term);
          return contribution === undefined ? [] : [{ docId, contribution }];
        })
        .sort(
          (left, right) =>
            right.contribution - left.contribution || left.docId.localeCompare(right.docId),
        ),
    );
  }
  expect(buildBm25fPostings([]).size).toBe(0);
  expect(
    buildBm25fPostings([{ id: 'empty', path: '', title: null, heading: '', body: '' }]).size,
  ).toBe(0);
});

describe('safe retrieval pruning prototype', () => {
  it('returns no candidates or work for unknown query terms', () => {
    const postings = new Map([['known', [{ docId: 'a', contribution: 3 }]]]);
    expect(exhaustiveTopK(postings, 'unknown', 1)).toEqual([]);
    expect(safePrunedTopK(postings, 'unknown', 1)).toEqual({
      results: [],
      evaluatedPostings: 0,
      totalPostings: 0,
    });
  });

  it('counts repeated Unicode query terms only once', () => {
    const postings = new Map([['café', [{ docId: 'a', contribution: 3 }]]]);
    expect(exhaustiveTopK(postings, 'CAFÉ café unknown', 1)).toEqual([{ docId: 'a', score: 3 }]);
    expect(safePrunedTopK(postings, 'CAFÉ café unknown', 1)).toEqual({
      results: [{ docId: 'a', score: 3 }],
      evaluatedPostings: 1,
      totalPostings: 1,
    });
  });

  it('does not prune a later candidate tied at the cutoff', () => {
    const postings = new Map([
      [
        'same',
        [
          { docId: 'b', contribution: 1 },
          { docId: 'a', contribution: 1 },
        ],
      ],
    ]);
    const pruned = safePrunedTopK(postings, 'same', 1);
    expect(pruned.results).toEqual([{ docId: 'a', score: 1 }]);
    expect(pruned.evaluatedPostings).toBe(2);
  });

  it('returns the exhaustive top-k result while skipping bounded postings', () => {
    const postings = new Map([
      [
        'alpha',
        [
          { docId: 'a', contribution: 10 },
          { docId: 'b', contribution: 1 },
          { docId: 'c', contribution: 0.5 },
        ],
      ],
      [
        'beta',
        [
          { docId: 'a', contribution: 9 },
          { docId: 'b', contribution: 1 },
          { docId: 'c', contribution: 0.5 },
        ],
      ],
    ]);

    const exhaustive = exhaustiveTopK(postings, 'alpha beta', 1);
    const pruned = safePrunedTopK(postings, 'alpha beta', 1);

    expect(pruned.results).toEqual(exhaustive);
    expect(pruned.evaluatedPostings).toBeLessThan(pruned.totalPostings);
  });

  it('keeps deterministic tie ordering', () => {
    const postings = new Map([
      [
        'same',
        [
          { docId: 'b', contribution: 1 },
          { docId: 'a', contribution: 1 },
        ],
      ],
    ]);

    expect(exhaustiveTopK(postings, 'same', 2)).toEqual([
      { docId: 'a', score: 1 },
      { docId: 'b', score: 1 },
    ]);
    expect(safePrunedTopK(postings, 'same', 2).results).toEqual([
      { docId: 'a', score: 1 },
      { docId: 'b', score: 1 },
    ]);
  });
});

interface PruningReport {
  protocol: { name: string; version: number };
  experiment: { topK: number; defaultRuntime: boolean };
  corpus: { manifestSha256: string; workloadSha256: string; chunks: number };
  measurements: { queries: number; evaluatedPostings: number; totalPostings: number };
  quality: {
    exactTopK: { numerator: number; denominator: number; ratio: number };
    cases: Array<{
      id: string;
      exact: boolean;
      exhaustive: Array<{ docId: string; score: number; path: string }>;
      pruned: Array<{ docId: string; score: number; path: string }>;
      evaluatedPostings: number;
      totalPostings: number;
    }>;
  };
}

describe('the offline pruning report command', () => {
  it('retains real results, input digests and complete counters in both outputs', () => {
    const root = resolve(import.meta.dirname, '../../..');
    const directory = mkdtempSync(join(tmpdir(), 'lorepack-pruning-report-'));
    try {
      const output = join(directory, 'report.json');
      const stdout = execFileSync(
        process.execPath,
        [join(root, 'scripts/research-safe-pruning.mjs'), '--out', output],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            LORE_BENCH_PACKS: '1',
            LORE_BENCH_SCALE: 'small',
            LORE_BENCH_PROFILE: 'mixed',
          },
        },
      );
      const report = JSON.parse(readFileSync(output, 'utf8')) as PruningReport;
      const manifest = readFileSync(join(root, 'benchmarks/corpus/manifest.json'));
      const workload = readFileSync(join(root, 'benchmarks/corpus/queries.json'));
      const queries = (
        JSON.parse(workload.toString()) as { qualityQueries: Array<{ id: string; kind: string }> }
      ).qualityQueries.filter(({ kind }) => kind === 'search');

      expect(JSON.parse(stdout)).toEqual(report);
      expect(report.protocol).toEqual({ name: 'lorepack-research-pruning', version: 1 });
      expect(report.experiment).toMatchObject({ topK: 5, defaultRuntime: false });
      expect(report.corpus.chunks).toBeGreaterThan(0);
      expect(report.corpus.manifestSha256).toBe(
        createHash('sha256').update(manifest).digest('hex'),
      );
      expect(report.corpus.workloadSha256).toBe(
        createHash('sha256').update(workload).digest('hex'),
      );
      expect(report.quality.cases.map(({ id }) => id)).toEqual(queries.map(({ id }) => id));
      expect(report.quality.exactTopK).toEqual({
        numerator: queries.length,
        denominator: queries.length,
        ratio: 1,
      });
      expect(report.measurements.queries).toBe(queries.length);
      let evaluated = 0;
      let total = 0;
      for (const entry of report.quality.cases) {
        expect(entry.exact).toBe(true);
        expect(entry.pruned).toEqual(entry.exhaustive);
        expect(entry.pruned.length).toBeLessThanOrEqual(report.experiment.topK);
        expect(entry.evaluatedPostings).toBeLessThanOrEqual(entry.totalPostings);
        evaluated += entry.evaluatedPostings;
        total += entry.totalPostings;
        for (const result of entry.pruned) {
          expect(result.path.length).toBeGreaterThan(0);
          expect(isAbsolute(result.path)).toBe(false);
          expect(result.path.split(/[\\/]/)).not.toContain('..');
        }
      }
      expect(total).toBeGreaterThan(0);
      expect(report.measurements.evaluatedPostings).toBe(evaluated);
      expect(report.measurements.totalPostings).toBe(total);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
