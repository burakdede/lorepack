#!/usr/bin/env node
/**
 * The retrieval benchmark: what ranking costs on top of the index, at scale.
 *
 * Separate from `scripts/bench.mjs` because it answers a different question. That one
 * measures the lifecycle; this one measures a query, which is the thing an agent does
 * hundreds of times per conversation, and it does so on a corpus large enough for BM25 to
 * mean something. A corpus of sixty near-identical documents makes every term common,
 * every score near zero, and every measurement optimistic.
 *
 * Results are **reported, not enforced**. Architecture section 5.5 states p95 < 250 ms
 * warm against a reference machine, and that machine is backlog issue #101 (Phase 7).
 * Every number here is labelled provisional and carries the machine that produced it.
 *
 *   node scripts/bench-retrieval.mjs [--out benchmarks/retrieval/local.json] [--documents 400]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { createLocalRuntimeBackend } from '../packages/backend-local/dist/index.js';
import { runBuild } from '../packages/cli/dist/services/build.js';
import { loadConfig, ProgressBus, RANKING_WEIGHTS_VERSION } from '../packages/core/dist/index.js';
import { createRuntime } from '../packages/runtime/dist/index.js';

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};

const DOCUMENTS = argument('documents', 400);
const SECTIONS = argument('sections', 8);
const ITERATIONS = argument('iterations', 60);

/**
 * Varied vocabulary, deterministically generated.
 *
 * A corpus where every document says the same words gives every term an inverse document
 * frequency of nearly zero, so BM25 collapses and the benchmark measures the tokenizer
 * rather than retrieval. Fifteen topics over a shared filler vocabulary produces the term
 * distribution a real corpus has, and the seeded generator keeps two runs comparable.
 */
const TOPICS = [
  'kubernetes',
  'postgres',
  'billing',
  'onboarding',
  'incident',
  'latency',
  'caching',
  'authentication',
  'webhooks',
  'migration',
  'observability',
  'payments',
  'search',
  'tenancy',
  'backups',
];
const FILLER =
  'cluster request queue retry budget quota latency payload schema tenant index shard replica cursor token window batch stream worker lease'.split(
    ' ',
  );

let seed = 20_260_802;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

function document(index) {
  const topic = TOPICS[index % TOPICS.length];
  const sections = [];
  for (let section = 0; section < SECTIONS; section += 1) {
    const body = Array.from(
      { length: 70 },
      () => FILLER[Math.floor(random() * FILLER.length)],
    ).join(' ');
    sections.push(`## ${topic} ${section === 0 ? 'overview' : `detail ${section}`}\n\n${body}\n`);
  }
  return `# ${topic} guide ${index}\n\n${sections.join('\n')}`;
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return Math.round((sorted[position] ?? 0) * 100) / 100;
}

const QUERIES = [
  'kubernetes',
  'postgres migration',
  'incident latency budget',
  'webhooks retry queue',
  'backups tenancy',
];

const root = mkdtempSync(join(tmpdir(), 'lorepack-retrieval-'));
try {
  writeFileSync(join(root, 'lore.yaml'), 'version: 1\nname: retrieval\nsources:\n  - .\n', 'utf8');
  mkdirSync(join(root, 'docs'), { recursive: true });
  for (let index = 0; index < DOCUMENTS; index += 1) {
    const topic = TOPICS[index % TOPICS.length];
    writeFileSync(
      join(root, 'docs', `${topic}-${String(index).padStart(4, '0')}.md`),
      document(index),
      'utf8',
    );
  }

  const built = await runBuild({
    config: loadConfig({ cwd: root }),
    progress: new ProgressBus(),
    allowLargeProject: true,
  });

  const backend = createLocalRuntimeBackend({ projectRoot: root });
  const runtime = createRuntime(backend);

  // The first query pays for opening the database and warming the page cache, so it is
  // reported separately rather than averaged into the steady state.
  const coldStart = performance.now();
  await runtime.search({ query: QUERIES[0], limit: 10, includeArchived: false, debug: false });
  const coldMs = performance.now() - coldStart;

  const samples = [];
  const debugSamples = [];
  const bundleSamples = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const query = QUERIES[index % QUERIES.length];
    const started = performance.now();
    await runtime.search({ query, limit: 10, includeArchived: false, debug: false });
    samples.push(performance.now() - started);

    const debugStarted = performance.now();
    await runtime.search({ query, limit: 10, includeArchived: false, debug: true });
    debugSamples.push(performance.now() - debugStarted);

    // Assembly is the expensive one: it ranks the whole candidate cap rather than a page,
    // and packs to a budget. Architecture 5.5 gates it at p95 under 1.5 s.
    const bundleStarted = performance.now();
    await runtime.contextForTask({ task: `${query} guidance`, includeArchived: false });
    bundleSamples.push(performance.now() - bundleStarted);
  }

  backend.close();

  const report = {
    provisional: true,
    reason:
      'Measured on the development machine. The reference machine and the gates are backlog issue #101.',
    rankingWeightsVersion: RANKING_WEIGHTS_VERSION,
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      node: process.versions.node,
    },
    corpus: {
      documents: DOCUMENTS,
      sectionsEach: SECTIONS,
      artifacts: built.counts.artifacts,
      chunks: built.counts.chunks,
      topics: TOPICS.length,
    },
    measurements: {
      coldSearchMs: Math.round(coldMs * 100) / 100,
      warmSearchP50Ms: percentile(samples, 0.5),
      warmSearchP95Ms: percentile(samples, 0.95),
      warmSearchP99Ms: percentile(samples, 0.99),
      debugSearchP95Ms: percentile(debugSamples, 0.95),
      contextBundleP50Ms: percentile(bundleSamples, 0.5),
      contextBundleP95Ms: percentile(bundleSamples, 0.95),
      iterations: ITERATIONS,
      queries: QUERIES.length,
    },
    referenceGates: { warmSearchP95Ms: 250, contextBundleP95Ms: 1500 },
  };

  const outIndex = process.argv.indexOf('--out');
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outIndex !== -1 && process.argv[outIndex + 1] !== undefined) {
    const out = process.argv[outIndex + 1];
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, serialized, 'utf8');
    console.log(`Wrote ${out}`);
  }
  console.log(serialized);
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
