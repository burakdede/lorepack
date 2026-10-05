#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createLocalRuntimeBackend } from '../packages/backend-local/dist/index.js';
import { createRuntime } from '../packages/runtime/dist/index.js';
import { buildAt, WORKLOAD, writeProject } from './bench-corpus.mjs';

const REPO = join(import.meta.dirname, '..');
const BASELINE_PATH = join(REPO, 'benchmarks/quality/baseline-2026-10-05.json');
const REPORT_PATH = join(REPO, 'benchmarks/quality/results-2026-10-05.json');

function expectedPath(artifact) {
  return `pack-000/000-${basename(artifact)}`;
}

export function matchesLocation(actual, expected) {
  if (actual.relativePath !== expectedPath(expected.artifact)) return false;
  for (const key of ['page', 'lineStart', 'lineEnd', 'sheet', 'cellRange']) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) return false;
  }
  if (expected.headingPath !== undefined) {
    if (JSON.stringify(actual.headingPath ?? []) !== JSON.stringify(expected.headingPath))
      return false;
  }
  return true;
}

export function evaluateQuality(cases) {
  const searches = cases.filter((entry) => entry.kind === 'search');
  const contexts = cases.filter((entry) => entry.kind === 'context');
  const searchHit = (entry, limit) =>
    entry.expected.some((expected) =>
      entry.hits.slice(0, limit).some((hit) => matchesLocation(hit.locator, expected)),
    );
  const contextHit = (entry) =>
    entry.expected.every((expected) =>
      entry.citations.some((citation) => matchesLocation(citation, expected)),
    );
  return {
    lexicalRankingQuality: true,
    search: {
      cases: searches.length,
      hitAt1: searches.filter((entry) => searchHit(entry, 1)).length / searches.length,
      hitAt5: searches.filter((entry) => searchHit(entry, 5)).length / searches.length,
    },
    contextForTask: {
      cases: contexts.length,
      allExpectedCited: contexts.filter(contextHit).length / contexts.length,
    },
  };
}

export function compareBaseline(actual, baseline) {
  const checks = [
    ['search.hitAt1', actual.search.hitAt1, baseline.search.hitAt1],
    ['search.hitAt5', actual.search.hitAt5, baseline.search.hitAt5],
    [
      'contextForTask.allExpectedCited',
      actual.contextForTask.allExpectedCited,
      baseline.contextForTask.allExpectedCited,
    ],
  ];
  return checks
    .filter(([, value, minimum]) => value < minimum)
    .map(([name, value, minimum]) => `${name} dropped from ${minimum} to ${value}`);
}

async function run() {
  const project = writeProject(1);
  await buildAt(project.root);
  const backend = createLocalRuntimeBackend({ projectRoot: project.root });
  try {
    const runtime = createRuntime(backend);
    const cases = [];
    for (const entry of WORKLOAD.qualityQueries) {
      if (entry.kind === 'search') {
        const result = await runtime.search({
          query: entry.query,
          limit: 5,
          includeArchived: false,
          debug: false,
        });
        cases.push({ ...entry, hits: result.hits });
      } else {
        const result = await runtime.contextForTask({
          task: entry.query,
          includeArchived: false,
        });
        cases.push({ ...entry, citations: result.citations });
      }
    }
    const quality = evaluateQuality(cases);
    const report = {
      generatedAt: '2026-10-05',
      corpusManifest: 'benchmarks/corpus/manifest.json',
      queryWorkload: 'benchmarks/corpus/queries.json',
      limitation:
        'This is lexical ranking quality on a repository-owned mixed-format corpus. It is not correctness, factuality, semantic relevance or an industry benchmark.',
      cases: WORKLOAD.qualityQueries.length,
      quality,
      machine: { platform: process.platform, arch: process.arch, node: process.versions.node },
    };
    const outputIndex = process.argv.indexOf('--out');
    const output = outputIndex === -1 ? REPORT_PATH : process.argv[outputIndex + 1];
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
    if (process.argv.includes('--check')) {
      const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).quality;
      const failures = compareBaseline(quality, baseline);
      if (failures.length > 0)
        throw new Error(`Retrieval quality regressed:\n${failures.join('\n')}`);
    }
  } finally {
    backend.close();
  }
}

if (process.argv[1] === import.meta.filename) await run();
