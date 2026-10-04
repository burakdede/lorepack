#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
/**
 * Compare Lorepack's runtime with a direct SQLite FTS5 index over the same built chunks.
 *
 * This is an opt-in measurement. The baseline intentionally starts after parsing and chunking:
 * it answers how much the local index and query layer cost, not whether a different tool can
 * ingest Lorepack's formats or preserve its build contract.
 *
 *   node scripts/bench-retrieval-comparison.mjs --out benchmarks/comparison/results-2026-10-04.json
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { createLocalRuntimeBackend } from '../packages/backend-local/dist/index.js';
import { createRuntime } from '../packages/runtime/dist/index.js';
import { buildAt, MANIFEST, WORKLOAD, writeProject } from './bench-corpus.mjs';

const PACKS = 40;
const SAMPLES = 3;
const QUERY_ITERATIONS = 30;
const CONTEXT_ITERATIONS = 20;

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return Math.round((sorted[position] ?? 0) * 100) / 100;
}

function peakRssMiB() {
  const maxRssBytes = Math.max(
    process.memoryUsage().rss,
    (process.resourceUsage().maxRSS ?? 0) * 1024,
  );
  return Math.round((maxRssBytes / 1024 ** 2) * 100) / 100;
}

async function buildLorepackSamples() {
  const samples = [];
  let lastRoot;
  let lastBuilt;
  let lastBytes = 0;
  try {
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const project = writeProject(PACKS);
      const started = performance.now();
      const built = await buildAt(project.root);
      samples.push(performance.now() - started);
      lastRoot = project.root;
      lastBuilt = built;
      lastBytes = project.bytes;
      if (sample < SAMPLES - 1) rmSync(project.root, { recursive: true, force: true });
    }
    return { samples, root: lastRoot, built: lastBuilt, bytes: lastBytes };
  } catch (error) {
    if (lastRoot !== undefined) rmSync(lastRoot, { recursive: true, force: true });
    throw error;
  }
}

const lorepack = await buildLorepackSamples();
const buildDatabasePath = join(
  lorepack.root,
  '.lore',
  'builds',
  lorepack.built.buildId,
  'context.sqlite',
);
const baselineProcess = spawnSync(
  process.execPath,
  [join(import.meta.dirname, 'bench-retrieval-baseline-worker.mjs'), buildDatabasePath],
  { encoding: 'utf8' },
);
if (baselineProcess.status !== 0) {
  throw new Error(`SQLite FTS5 baseline failed: ${baselineProcess.stderr}`);
}
const baseline = JSON.parse(baselineProcess.stdout.trim());

const backend = createLocalRuntimeBackend({ projectRoot: lorepack.root });
const runtime = createRuntime(backend);
const lorepackColdStarted = performance.now();
const lorepackColdResult = await runtime.search({
  query: WORKLOAD.searchQueries[0],
  limit: 10,
  includeArchived: false,
  debug: false,
});
const lorepackCold = {
  elapsed: performance.now() - lorepackColdStarted,
  count: lorepackColdResult.hits.length,
};
const lorepackWarm = [];
const lorepackTopK = [];
for (let index = 0; index < QUERY_ITERATIONS; index += 1) {
  const started = performance.now();
  const result = await runtime.search({
    query: WORKLOAD.searchQueries[index % WORKLOAD.searchQueries.length],
    limit: 10,
    includeArchived: false,
    debug: false,
  });
  lorepackWarm.push(performance.now() - started);
  lorepackTopK.push(result.hits.length);
}
const contextSamples = [];
for (let index = 0; index < CONTEXT_ITERATIONS; index += 1) {
  const started = performance.now();
  await runtime.contextForTask({
    task: WORKLOAD.contextTasks[index % WORKLOAD.contextTasks.length],
    includeArchived: false,
  });
  contextSamples.push(performance.now() - started);
}
const lorepackPeakRssMiB = peakRssMiB();
backend.close();

const report = {
  provisional: true,
  reportedNotEnforced: true,
  generatedAt: '2026-10-04',
  corpusManifest: 'benchmarks/corpus/manifest.json',
  queryWorkload: 'benchmarks/corpus/queries.json',
  semantics: {
    baseline:
      'Direct SQLite FTS5 over Lorepack normalized chunks. It starts after parsing and chunking.',
    lorepack: 'Full local runtime search and context assembly over the same sealed build.',
    tableAndBuildContract:
      'The baseline does not preserve build identity, SourceLocator objects, authority or status ranking, context omission reports, table structure, activation, or rollback.',
  },
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    node: process.versions.node,
    sqlite: process.versions.sqlite ?? 'node:sqlite bundled SQLite',
  },
  corpus: {
    packs: PACKS,
    artifacts: lorepack.built.counts.artifacts,
    bytes: lorepack.bytes,
    chunks: lorepack.built.counts.chunks,
    tables: lorepack.built.counts.tables,
    tableRows: lorepack.built.counts.tableRows,
    manifestArtifacts: MANIFEST.artifacts.length,
  },
  samples: {
    build: SAMPLES,
    index: SAMPLES,
    warmSearch: QUERY_ITERATIONS,
    contextBundle: CONTEXT_ITERATIONS,
  },
  baselines: {
    lorepack: {
      indexBytes: statSync(buildDatabasePath).size,
      peakRssMiB: lorepackPeakRssMiB,
      buildMs: {
        p50: percentile(lorepack.samples, 0.5),
        p95: percentile(lorepack.samples, 0.95),
        samples: SAMPLES,
      },
      coldSearchMs: Math.round(lorepackCold.elapsed * 100) / 100,
      warmSearchMs: {
        p50: percentile(lorepackWarm, 0.5),
        p95: percentile(lorepackWarm, 0.95),
        p99: percentile(lorepackWarm, 0.99),
        samples: QUERY_ITERATIONS,
      },
      contextBundleMs: {
        p50: percentile(contextSamples, 0.5),
        p95: percentile(contextSamples, 0.95),
        samples: CONTEXT_ITERATIONS,
      },
      topK: { min: Math.min(...lorepackTopK), max: Math.max(...lorepackTopK) },
    },
    sqliteFts5: {
      ...baseline,
    },
  },
};

rmSync(lorepack.root, { recursive: true, force: true });
const serialized = `${JSON.stringify(report, null, 2)}\n`;
const outputIndex = process.argv.indexOf('--out');
if (outputIndex !== -1 && process.argv[outputIndex + 1] !== undefined) {
  const output = process.argv[outputIndex + 1];
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, serialized, 'utf8');
  console.log(`Wrote ${output}`);
}
console.log(serialized);
