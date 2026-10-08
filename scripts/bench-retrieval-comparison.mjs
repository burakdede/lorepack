#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
/**
 * Compare Lorepack's runtime with a direct SQLite FTS5 index over the same built chunks.
 *
 * This is an opt-in measurement. The baseline intentionally starts after parsing and chunking:
 * it answers how much the local index and query layer cost, not whether a different tool can
 * ingest Lorepack's formats or preserve its build contract.
 *
 *   node scripts/bench-retrieval-comparison.mjs --out benchmarks/comparison/results-2026-10-04.json
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { createLocalRuntimeBackend } from '../packages/backend-local/dist/index.js';
import { createRuntime } from '../packages/runtime/dist/index.js';
import { buildAt, MANIFEST, WORKLOAD, writeProject } from './bench-corpus.mjs';
import { matchesLocation } from './bench-quality.mjs';
import { validateBenchmarkReport } from './benchmark-report.mjs';

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

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function phase(report, name) {
  return report.measurements.phases.find((entry) => entry.name === name);
}

function validateReport(report, label) {
  const problems = validateBenchmarkReport(report);
  if (problems.length > 0)
    throw new Error(`${label} violates benchmark protocol:\n${problems.join('\n')}`);
}

async function lorepackQuality(runtime) {
  const searches = [];
  const contexts = [];
  for (const entry of WORKLOAD.qualityQueries) {
    if (entry.kind === 'search') {
      const result = await runtime.search({
        query: entry.query,
        limit: 5,
        includeArchived: false,
        debug: false,
      });
      searches.push({ ...entry, hits: result.hits });
    } else {
      const result = await runtime.contextForTask({
        task: entry.query,
        includeArchived: false,
      });
      contexts.push({ ...entry, citations: result.citations });
    }
  }
  const hitAt = (entry, limit) =>
    entry.expected.some((expected) =>
      entry.hits.slice(0, limit).some((hit) => matchesLocation(hit.locator, expected)),
    );
  const contextHit = (entry) =>
    entry.expected.every((expected) =>
      entry.citations.some((citation) => matchesLocation(citation, expected)),
    );
  return {
    search: {
      cases: searches.length,
      hitAt1: searches.filter((entry) => hitAt(entry, 1)).length / searches.length,
      hitAt5: searches.filter((entry) => hitAt(entry, 5)).length / searches.length,
      expectedLocationCoverage:
        searches.filter((entry) => hitAt(entry, 5)).length / searches.length,
    },
    provenance: {
      available: true,
      coverage: 1,
      note: 'Every runtime hit and context citation carries a SourceLocator.',
    },
    context: {
      status: 'measured',
      cases: contexts.length,
      allExpectedCited: contexts.filter(contextHit).length / contexts.length,
    },
  };
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
  [
    join(import.meta.dirname, 'bench-retrieval-baseline-worker.mjs'),
    buildDatabasePath,
    JSON.stringify({
      commitSha:
        process.env.GITHUB_SHA ??
        execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      manifestSha256: sha256(join(import.meta.dirname, '..', 'benchmarks/corpus/manifest.json')),
      workloadSha256: sha256(join(import.meta.dirname, '..', 'benchmarks/corpus/queries.json')),
      scale: 'large',
      profile: 'mixed',
      artifacts: lorepack.built.counts.artifacts,
      bytes: lorepack.bytes,
      tables: lorepack.built.counts.tables,
    }),
  ],
  { encoding: 'utf8' },
);
if (baselineProcess.status !== 0) {
  throw new Error(`SQLite FTS5 baseline failed: ${baselineProcess.stderr}`);
}
const baseline = JSON.parse(baselineProcess.stdout.trim());
validateReport(baseline, 'SQLite FTS5 baseline');

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
let estimatedContextTokens = 0;
for (let index = 0; index < CONTEXT_ITERATIONS; index += 1) {
  const started = performance.now();
  const bundle = await runtime.contextForTask({
    task: WORKLOAD.contextTasks[index % WORKLOAD.contextTasks.length],
    includeArchived: false,
  });
  estimatedContextTokens += bundle.estimatedTokens;
  contextSamples.push(performance.now() - started);
}
const lorepackQualityResult = await lorepackQuality(runtime);
const lorepackPeakRssMiB = peakRssMiB();
backend.close();

const commitSha =
  process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const manifestSha256 = sha256(join(import.meta.dirname, '..', 'benchmarks/corpus/manifest.json'));
const workloadSha256 = sha256(join(import.meta.dirname, '..', 'benchmarks/corpus/queries.json'));
const common = {
  commitSha,
  manifestSha256,
  workloadSha256,
  scale: 'large',
  profile: 'mixed',
  artifacts: lorepack.built.counts.artifacts,
  bytes: lorepack.bytes,
  tables: lorepack.built.counts.tables,
};
const lorepackReport = {
  protocol: { name: 'lorepack-benchmark', version: 1 },
  reportId: `lorepack-${common.scale}-${common.profile}-${commitSha.slice(0, 12)}`,
  generatedAt: new Date().toISOString(),
  commitSha,
  implementation: { name: 'lorepack-runtime', version: 'workspace' },
  environment: {
    platform: process.platform,
    arch: process.arch,
    runner:
      process.env.GITHUB_ACTIONS === 'true'
        ? (process.env.RUNNER_NAME ?? 'github-actions')
        : 'local',
    node: process.versions.node,
    cpu: cpus()[0]?.model ?? 'unknown',
    storageClass: process.env.LORE_BENCH_STORAGE_CLASS ?? 'unknown',
    sqlite: process.versions.sqlite ?? 'node:sqlite bundled SQLite',
  },
  corpus: {
    manifestPath: 'benchmarks/corpus/manifest.json',
    manifestSha256,
    scale: common.scale,
    profile: common.profile,
    artifacts: common.artifacts,
    bytes: common.bytes,
    chunks: lorepack.built.counts.chunks,
    tables: common.tables,
  },
  workload: {
    path: 'benchmarks/corpus/queries.json',
    sha256: workloadSha256,
    queryCount: WORKLOAD.searchQueries.length,
    contextTaskCount: WORKLOAD.contextTasks.length,
    tableQueryCount: 1,
  },
  samples: { warmup: 1, repetitions: SAMPLES, timeoutMs: 30000 },
  tokenAccounting: {
    status: 'estimated',
    tokenizer: 'lorepack-estimator-v1',
    model: null,
    inputTokens: null,
    retrievedContextTokens: estimatedContextTokens,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
  },
  measurements: {
    phases: [
      {
        name: 'build',
        p50Ms: percentile(lorepack.samples, 0.5),
        p95Ms: percentile(lorepack.samples, 0.95),
        samples: SAMPLES,
        errorCount: 0,
      },
      {
        name: 'cold-query',
        p50Ms: lorepackCold.elapsed,
        p95Ms: lorepackCold.elapsed,
        samples: 1,
        errorCount: 0,
      },
      {
        name: 'warm-query',
        p50Ms: percentile(lorepackWarm, 0.5),
        p95Ms: percentile(lorepackWarm, 0.95),
        samples: QUERY_ITERATIONS,
        errorCount: 0,
      },
      {
        name: 'context-assembly',
        p50Ms: percentile(contextSamples, 0.5),
        p95Ms: percentile(contextSamples, 0.95),
        samples: CONTEXT_ITERATIONS,
        errorCount: 0,
      },
    ],
  },
  quality: lorepackQualityResult,
  configuration: {
    tokenizer: 'Lorepack catalog FTS5 plus deterministic runtime ranker',
    ranking: 'candidate retrieval followed by rankCandidates structural and status-aware ranking',
    columns: ['path', 'title', 'heading', 'body'],
    normalization: 'Lorepack canonical build normalization and chunking.',
    sourceBoundary: 'Full build and sealed local runtime.',
  },
  resources: {
    indexBytes: statSync(buildDatabasePath).size,
    peakRssMiB: lorepackPeakRssMiB,
    topK: { min: Math.min(...lorepackTopK), max: Math.max(...lorepackTopK) },
  },
  claims: [
    {
      id: 'lorepack-lifecycle',
      status: 'measured',
      statement:
        'Lorepack measures build, query and context lifecycle phases over the shared workload.',
      evidence: ['measurements.phases'],
    },
    {
      id: 'lorepack-provenance',
      status: 'quality-result',
      statement: 'Lorepack returns provenance-bearing hits and context citations.',
      evidence: ['quality.provenance'],
    },
    {
      id: 'lorepack-semantic-quality',
      status: 'not-measured',
      statement: 'This comparison does not claim semantic superiority over a neural retriever.',
      evidence: [],
    },
  ],
};
validateReport(lorepackReport, 'Lorepack report');

const report = {
  protocol: { name: 'lorepack-benchmark-comparison', version: 1 },
  provisional: true,
  reportedNotEnforced: true,
  generatedAt: new Date().toISOString(),
  commitSha,
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
  protocolReports: { lorepack: lorepackReport, sqliteFts5: baseline },
  baselines: {
    lorepack: {
      indexBytes: lorepackReport.resources.indexBytes,
      peakRssMiB: lorepackReport.resources.peakRssMiB,
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
      quality: lorepackQualityResult,
    },
    sqliteFts5: {
      indexBytes: baseline.resources.indexBytes,
      peakRssMiB: baseline.resources.peakRssMiB,
      indexMs: phase(baseline, 'index-build'),
      coldSearchMs: phase(baseline, 'cold-query')?.p50Ms,
      warmSearchMs: phase(baseline, 'warm-query'),
      contextBundleMs: null,
      contextUnsupportedReason: baseline.quality.context.reason,
      topK: baseline.resources.topK,
      quality: baseline.quality,
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
