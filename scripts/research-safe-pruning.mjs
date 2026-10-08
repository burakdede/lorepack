#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RANKING_WEIGHTS, RANKING_WEIGHTS_VERSION } from '../packages/core/dist/index.js';
import { buildAt, writeProject } from './bench-corpus.mjs';

const output = option('--out');
const packs = Number(process.env.LORE_BENCH_PACKS ?? 1);
const scale =
  process.env.LORE_BENCH_SCALE ?? (packs === 1 ? 'small' : packs === 10 ? 'medium' : 'large');
const profile = process.env.LORE_BENCH_PROFILE ?? 'mixed';
const topK = Number(process.env.LORE_RESEARCH_TOP_K ?? 5);
const root = join(import.meta.dirname, '..');
const manifestPath = join(root, 'benchmarks/corpus/manifest.json');
const workloadPath = join(root, 'benchmarks/corpus/queries.json');
const workload = JSON.parse(readFileSync(workloadPath, 'utf8'));

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    Math.round(
      (sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0) * 100,
    ) / 100
  );
}

function tokens(value) {
  return (
    String(value ?? '')
      .toLocaleLowerCase('en-US')
      .match(/[\p{L}\p{N}_]+/gu) ?? []
  );
}

function addFieldTerms(target, value, weight) {
  const counts = new Map();
  for (const term of tokens(value)) counts.set(term, (counts.get(term) ?? 0) + 1);
  for (const [term, count] of counts) {
    const existing = target.get(term) ?? [];
    existing.push({ weight, count });
    target.set(term, existing);
  }
}

function buildPostings(rows) {
  const fields = RANKING_WEIGHTS.columns;
  const perDocument = new Map();
  const documentFrequency = new Map();
  for (const row of rows) {
    const terms = new Map();
    addFieldTerms(terms, row.path, fields.path);
    addFieldTerms(terms, row.title, fields.title);
    addFieldTerms(terms, row.heading, fields.heading);
    addFieldTerms(terms, row.body, fields.body);
    perDocument.set(row.id, { row, terms });
    for (const term of terms.keys())
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const postings = new Map();
  const documentTermScores = new Map();
  for (const { row, terms } of perDocument.values()) {
    for (const [term, contributions] of terms) {
      const idf = Math.log(
        1 +
          (rows.length - (documentFrequency.get(term) ?? 0) + 0.5) /
            ((documentFrequency.get(term) ?? 0) + 0.5),
      );
      const contribution = contributions.reduce(
        (total, field) => total + field.weight * idf * (field.count / (field.count + 1)),
        0,
      );
      const list = postings.get(term) ?? [];
      list.push({ docId: row.id, contribution });
      postings.set(term, list);
      const termScores = documentTermScores.get(row.id) ?? new Map();
      termScores.set(term, contribution);
      documentTermScores.set(row.id, termScores);
    }
  }
  for (const list of postings.values())
    list.sort((a, b) => b.contribution - a.contribution || a.docId.localeCompare(b.docId));
  postings.documentTermScores = documentTermScores;
  return postings;
}

function buildBm25fPostings(rows) {
  const fields = [
    { name: 'path', weight: RANKING_WEIGHTS.columns.path, b: 0.2 },
    { name: 'title', weight: RANKING_WEIGHTS.columns.title, b: 0.2 },
    { name: 'heading', weight: RANKING_WEIGHTS.columns.heading, b: 0.35 },
    { name: 'body', weight: RANKING_WEIGHTS.columns.body, b: 0.75 },
  ];
  const k1 = 1.2;
  const fieldData = rows.map((row) => {
    const values = new Map();
    for (const field of fields) values.set(field.name, tokens(row[field.name]));
    return { row, values };
  });
  const averages = new Map(
    fields.map((field) => [
      field.name,
      fieldData.reduce((total, item) => total + item.values.get(field.name).length, 0) /
        rows.length,
    ]),
  );
  const documentFrequency = new Map();
  for (const item of fieldData) {
    const terms = new Set(fields.flatMap((field) => item.values.get(field.name)));
    for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const postings = new Map();
  const documentTermScores = new Map();
  for (const item of fieldData) {
    const terms = new Set(fields.flatMap((field) => item.values.get(field.name)));
    for (const term of terms) {
      const frequency = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (rows.length - frequency + 0.5) / (frequency + 0.5));
      const normalizedTermFrequency = fields.reduce((total, field) => {
        const values = item.values.get(field.name);
        const termFrequency = values.filter((value) => value === term).length;
        const averageLength = averages.get(field.name) || 1;
        const normalization = 1 - field.b + field.b * (values.length / averageLength);
        return total + field.weight * (termFrequency / normalization);
      }, 0);
      const contribution =
        (idf * (k1 + 1) * normalizedTermFrequency) / (k1 + normalizedTermFrequency);
      const list = postings.get(term) ?? [];
      list.push({ docId: item.row.id, contribution });
      postings.set(term, list);
      const termScores = documentTermScores.get(item.row.id) ?? new Map();
      termScores.set(term, contribution);
      documentTermScores.set(item.row.id, termScores);
    }
  }
  for (const list of postings.values())
    list.sort((a, b) => b.contribution - a.contribution || a.docId.localeCompare(b.docId));
  postings.documentTermScores = documentTermScores;
  return postings;
}

function rank(scores, limit) {
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([docId, score]) => ({ docId, score: Math.round(score * 1e12) / 1e12 }));
}

export function exhaustiveTopK(postings, query, limit = topK) {
  const scores = new Map();
  for (const term of new Set(tokens(query))) {
    for (const posting of postings.get(term) ?? [])
      scores.set(posting.docId, (scores.get(posting.docId) ?? 0) + posting.contribution);
  }
  return rank(scores, limit);
}

export function safePrunedTopK(postings, query, limit = topK) {
  const terms = [...new Set(tokens(query))].filter((term) => postings.has(term));
  const cursors = new Map(terms.map((term) => [term, 0]));
  const scores = new Map();
  const documentTermScores = postings.documentTermScores ?? new Map();
  if (documentTermScores.size === 0) {
    for (const list of postings.values()) {
      const term = terms.find((candidate) => postings.get(candidate) === list);
      if (term === undefined) continue;
      for (const posting of list) {
        const termScores = documentTermScores.get(posting.docId) ?? new Map();
        termScores.set(term, posting.contribution);
        documentTermScores.set(posting.docId, termScores);
      }
    }
  }
  const exactScore = (docId) =>
    terms.reduce((total, term) => total + (documentTermScores.get(docId)?.get(term) ?? 0), 0);
  let evaluatedPostings = 0;

  while (terms.length > 0) {
    const current = rank(scores, limit);
    if (current.length === limit) {
      const cutoff = current.at(-1).score;
      const top = new Set(current.map((entry) => entry.docId));
      let upperBound = 0;
      for (const term of terms)
        upperBound += postings.get(term)[cursors.get(term)]?.contribution ?? 0;
      for (const [docId, score] of scores) {
        if (top.has(docId)) continue;
        let candidateBound = score;
        for (const term of terms)
          candidateBound += postings.get(term)[cursors.get(term)]?.contribution ?? 0;
        upperBound = Math.max(upperBound, candidateBound);
      }
      if (upperBound < cutoff)
        return {
          results: current,
          evaluatedPostings,
          totalPostings: terms.reduce((total, term) => total + postings.get(term).length, 0),
        };
    }

    let selectedTerm = null;
    let selectedPosting = null;
    for (const term of terms) {
      const posting = postings.get(term)[cursors.get(term)];
      if (
        posting !== undefined &&
        (selectedPosting === null ||
          posting.contribution > selectedPosting.contribution ||
          (posting.contribution === selectedPosting.contribution && term < selectedTerm))
      ) {
        selectedTerm = term;
        selectedPosting = posting;
      }
    }
    if (selectedTerm === null) break;
    cursors.set(selectedTerm, cursors.get(selectedTerm) + 1);
    scores.set(selectedPosting.docId, exactScore(selectedPosting.docId));
    evaluatedPostings += 1;
  }
  return {
    results: rank(scores, limit),
    evaluatedPostings,
    totalPostings: terms.reduce((total, term) => total + postings.get(term).length, 0),
  };
}

function readRows(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const rows = database
    .prepare(
      `SELECT c.id, c.relative_path AS path, a.title, c.heading_path AS heading, c.text AS body,
            c.line_start AS lineStart, c.line_end AS lineEnd, c.page
       FROM chunks AS c
      JOIN artifacts AS a ON a.id = c.artifact_id
      ORDER BY c.id`,
    )
    .all();
  database.close();
  return rows;
}

function createFts5Index(rows) {
  const database = new DatabaseSync(':memory:');
  database.exec(
    'CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED, path, title, heading, body)',
  );
  const insert = database.prepare(
    'INSERT INTO chunks_fts (id, path, title, heading, body) VALUES (?, ?, ?, ?, ?)',
  );
  for (const row of rows)
    insert.run(row.id, row.path, row.title ?? '', row.heading ?? '', row.body ?? '');
  return database;
}

function fts5TopK(database, query, limit) {
  const match = tokens(query).join(' OR ');
  if (match.length === 0) return [];
  return database
    .prepare(
      'SELECT id AS docId, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?',
    )
    .all(match, limit)
    .map((row) => ({ docId: row.docId, score: row.score }));
}

function resultLocations(results, rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return results.map(({ docId, score }) => {
    const row = byId.get(docId);
    return {
      docId,
      score,
      path: row.path,
      lineStart: row.lineStart,
      lineEnd: row.lineEnd,
      page: row.page,
    };
  });
}

async function main() {
  const project = writeProject(packs);
  try {
    const built = await buildAt(project.root);
    const databasePath = join(project.root, '.lore', 'builds', built.buildId, 'context.sqlite');
    const rows = readRows(databasePath);
    const postings = buildPostings(rows);
    const bm25fPostings = buildBm25fPostings(rows);
    const fts5 = createFts5Index(rows);
    const queries = workload.qualityQueries.filter((entry) => entry.kind === 'search');
    const exhaustiveTimes = [];
    const prunedTimes = [];
    const fts5Times = [];
    const bm25fTimes = [];
    let exact = 0;
    let evaluatedPostings = 0;
    let totalPostings = 0;
    let fts5Exact = 0;
    let fts5Overlap = 0;
    let bm25fOverlap = 0;
    let bm25fFts5Overlap = 0;
    const cases = [];
    for (const entry of queries) {
      const exhaustiveStarted = performance.now();
      const exhaustive = exhaustiveTopK(postings, entry.query, topK);
      exhaustiveTimes.push(performance.now() - exhaustiveStarted);
      const prunedStarted = performance.now();
      const pruned = safePrunedTopK(postings, entry.query, topK);
      prunedTimes.push(performance.now() - prunedStarted);
      const fts5Started = performance.now();
      const directFts5 = fts5TopK(fts5, entry.query, topK);
      fts5Times.push(performance.now() - fts5Started);
      const bm25fStarted = performance.now();
      const bm25f = exhaustiveTopK(bm25fPostings, entry.query, topK);
      bm25fTimes.push(performance.now() - bm25fStarted);
      const same = JSON.stringify(pruned.results) === JSON.stringify(exhaustive);
      const sameAsFts5 =
        JSON.stringify(directFts5.map((result) => result.docId)) ===
        JSON.stringify(exhaustive.map((result) => result.docId));
      fts5Exact += sameAsFts5 ? 1 : 0;
      fts5Overlap += directFts5.filter((result) =>
        exhaustive.some((item) => item.docId === result.docId),
      ).length;
      bm25fOverlap += bm25f.filter((result) =>
        exhaustive.some((item) => item.docId === result.docId),
      ).length;
      bm25fFts5Overlap += bm25f.filter((result) =>
        directFts5.some((item) => item.docId === result.docId),
      ).length;
      if (same) exact += 1;
      evaluatedPostings += pruned.evaluatedPostings;
      totalPostings += pruned.totalPostings;
      cases.push({
        id: entry.id,
        query: entry.query,
        exact: same,
        exhaustive: resultLocations(exhaustive, rows),
        pruned: resultLocations(pruned.results, rows),
        directFts5: resultLocations(directFts5, rows),
        bm25f: resultLocations(bm25f, rows),
        evaluatedPostings: pruned.evaluatedPostings,
        totalPostings: pruned.totalPostings,
      });
    }
    const report = {
      protocol: { name: 'lorepack-research-pruning', version: 1 },
      generatedAt: new Date().toISOString(),
      commitSha:
        process.env.GITHUB_SHA ??
        execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      experiment: {
        name: 'safe-upper-bound-top-k',
        ranking: 'field-aware-additive-v1',
        rankingWeightsVersion: RANKING_WEIGHTS_VERSION,
        topK,
        defaultRuntime: false,
      },
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        cpu: cpus()[0]?.model ?? 'unknown',
      },
      corpus: {
        manifestPath: 'benchmarks/corpus/manifest.json',
        manifestSha256: sha256(manifestPath),
        workloadPath: 'benchmarks/corpus/queries.json',
        workloadSha256: sha256(workloadPath),
        scale,
        profile,
        chunks: rows.length,
      },
      measurements: {
        exhaustiveP95Ms: percentile(exhaustiveTimes, 0.95),
        prunedP95Ms: percentile(prunedTimes, 0.95),
        directFts5P95Ms: percentile(fts5Times, 0.95),
        bm25fP95Ms: percentile(bm25fTimes, 0.95),
        queries: queries.length,
        evaluatedPostings,
        totalPostings,
        postingReduction: totalPostings === 0 ? 0 : 1 - evaluatedPostings / totalPostings,
      },
      quality: {
        exactTopK: {
          numerator: exact,
          denominator: queries.length,
          ratio: queries.length === 0 ? 1 : exact / queries.length,
        },
        directFts5: {
          exactTopK: {
            numerator: fts5Exact,
            denominator: queries.length,
            ratio: queries.length === 0 ? 1 : fts5Exact / queries.length,
          },
          topKOverlap: {
            numerator: fts5Overlap,
            denominator: queries.length * topK,
            ratio: queries.length === 0 ? 1 : fts5Overlap / (queries.length * topK),
          },
        },
        bm25f: {
          topKOverlapWithAdditive: {
            numerator: bm25fOverlap,
            denominator: queries.length * topK,
            ratio: queries.length === 0 ? 1 : bm25fOverlap / (queries.length * topK),
          },
          topKOverlapWithFts5: {
            numerator: bm25fFts5Overlap,
            denominator: queries.length * topK,
            ratio: queries.length === 0 ? 1 : bm25fFts5Overlap / (queries.length * topK),
          },
        },
        cases,
      },
      claims: [
        {
          id: 'safe-exactness',
          status: exact === queries.length ? 'quality-result' : 'failed-experiment',
          statement:
            'The pruned method returns the same top-k IDs and scores as exhaustive scoring for every shared search query.',
          evidence: ['quality.exactTopK'],
        },
        {
          id: 'pruning-speed',
          status: 'reported-only',
          statement:
            'The prototype reports candidate evaluation reduction and query timings; it is not a default runtime path.',
          evidence: ['measurements'],
        },
        {
          id: 'direct-fts5-comparison',
          status: 'measured',
          statement:
            'The same queries are reported against direct SQLite FTS5, without claiming score or ranking equivalence.',
          evidence: ['quality.directFts5', 'measurements.directFts5P95Ms'],
        },
        {
          id: 'bm25f-comparison',
          status: 'reported-only',
          statement:
            'The deterministic BM25F-style variant is compared on the shared workload without treating ranking overlap as semantic truth.',
          evidence: ['quality.bm25f', 'measurements.bm25fP95Ms'],
        },
      ],
      limitations: [
        'The prototype uses a research-only additive field score and is not the full runtime ranker.',
        'The report does not claim a WAND or Block-Max WAND implementation until the exact index structure and equivalence gate are met.',
        'Direct FTS5 uses its own BM25 ranking, so overlap is descriptive and not an exactness gate for the pruning method.',
        'The local corpus is a regression fixture, not an industry retrieval benchmark.',
      ],
    };
    if (output) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    rmSync(project.root, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('research-safe-pruning.mjs')) await main();
