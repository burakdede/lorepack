#!/usr/bin/env node
import { createHash } from 'node:crypto';
/**
 * Benchmark a checked-in mixed-format corpus at three scales.
 *
 * The corpus is deliberately small enough to run on a developer machine. It measures real
 * parser inputs first, then repeats those inputs with deterministic path-local text so the
 * scale trend is visible without pretending that repeated fixtures are an industry corpus.
 * The raw result records that limitation and is reported, not enforced.
 *
 *   node scripts/bench-corpus.mjs --out benchmarks/corpus/results-2026-10-04.json
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalRuntimeBackend } from '../packages/backend-local/dist/index.js';
import { runBuild } from '../packages/cli/dist/services/build.js';
import { loadConfig, ProgressBus } from '../packages/core/dist/index.js';
import { createRuntime } from '../packages/runtime/dist/index.js';

const REPO = join(import.meta.dirname, '..');
const MANIFEST_PATH = join(REPO, 'benchmarks/corpus/manifest.json');
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const WORKLOAD = JSON.parse(readFileSync(join(REPO, 'benchmarks/corpus/queries.json'), 'utf8'));
const SAMPLES = 3;
const QUERY_ITERATIONS = 30;
const CONTEXT_ITERATIONS = 20;
const TABLE_ITERATIONS = 20;
const tiers = ['small', 'medium', 'large'];

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return Math.round((sorted[position] ?? 0) * 100) / 100;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function peakRssBytes() {
  const resourceRss = (process.resourceUsage().maxRSS ?? 0) * 1024;
  return Math.max(process.memoryUsage().rss, resourceRss);
}

function addPathSuffix(contents, extension, pack) {
  const marker = `Benchmark pack ${String(pack).padStart(3, '0')}.`;
  if (extension === '.html') {
    return contents.replace('</body>', `<p>${marker}</p></body>`);
  }
  if (extension === '.csv') {
    return `${contents.trimEnd()}\nbenchmark-${pack},${marker.replace('.', '')},medium\n`;
  }
  if (extension === '.ts') {
    return `${contents}\n// ${marker}\n`;
  }
  return `${contents}\n\n## ${marker}\n\nThis path identifies the deterministic corpus copy.\n`;
}

function writeProject(packs) {
  const root = mkdtempSync(join(tmpdir(), 'lorepack-corpus-'));
  let bytes = 0;
  writeFileSync(
    join(root, 'lore.yaml'),
    'version: 1\nname: corpus\nsources:\n  - sources\n',
    'utf8',
  );
  for (let pack = 0; pack < packs; pack += 1) {
    const packDir = join(root, 'sources', `pack-${String(pack).padStart(3, '0')}`);
    mkdirSync(packDir, { recursive: true });
    for (const artifact of MANIFEST.artifacts) {
      const source = join(REPO, artifact.path);
      const destination = join(
        packDir,
        `${String(pack).padStart(3, '0')}-${artifact.path.split('/').at(-1)}`,
      );
      const extension = extname(artifact.path).toLowerCase();
      if (['.md', '.html', '.csv', '.txt', '.ts'].includes(extension)) {
        writeFileSync(
          destination,
          addPathSuffix(readFileSync(source, 'utf8'), extension, pack),
          'utf8',
        );
      } else {
        copyFileSync(source, destination);
      }
      bytes += statSync(destination).size;
    }
  }
  return { root, bytes };
}

async function buildAt(root) {
  return runBuild({
    config: loadConfig({ cwd: root }),
    progress: new ProgressBus(),
    allowLargeProject: true,
  });
}

async function measureTier(name) {
  const packs = MANIFEST.tiers[name].packs;
  const buildSamples = [];
  let lastRoot;
  let lastBuild;
  let lastProjectBytes = 0;
  try {
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const project = writeProject(packs);
      const root = project.root;
      const started = performance.now();
      const built = await buildAt(root);
      buildSamples.push(performance.now() - started);
      lastRoot = root;
      lastBuild = built;
      lastProjectBytes = project.bytes;
      if (sample < SAMPLES - 1) rmSync(root, { recursive: true, force: true });
    }

    const incrementalSamples = [];
    const incrementalReused = [];
    const edited = join(lastRoot, 'sources', 'pack-000', '000-product-strategy.md');
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      writeFileSync(
        edited,
        `${readFileSync(edited, 'utf8')}\nIncremental edit ${sample}.\n`,
        'utf8',
      );
      const started = performance.now();
      const rebuilt = await buildAt(lastRoot);
      incrementalSamples.push(performance.now() - started);
      incrementalReused.push(rebuilt.reusedArtifacts);
      const expectedReusable = lastBuild.counts.artifacts - 1 - lastBuild.counts.tables;
      if (rebuilt.reusedArtifacts < expectedReusable) {
        throw new Error(
          `incremental build reused ${rebuilt.reusedArtifacts} artifacts, expected at least ${expectedReusable}`,
        );
      }
    }

    const backend = createLocalRuntimeBackend({ projectRoot: lastRoot });
    const runtime = createRuntime(backend);
    const tables = await runtime.listTables();
    const firstTable =
      tables[0] === undefined ? undefined : await runtime.describeTable(tables[0].tableId);
    const querySamples = [];
    const contextSamples = [];
    const tableSamples = [];
    for (let index = 0; index < QUERY_ITERATIONS; index += 1) {
      const started = performance.now();
      await runtime.search({
        query: WORKLOAD.searchQueries[index % WORKLOAD.searchQueries.length],
        limit: 10,
        includeArchived: false,
        debug: false,
      });
      querySamples.push(performance.now() - started);
    }
    for (let index = 0; index < CONTEXT_ITERATIONS; index += 1) {
      const started = performance.now();
      await runtime.contextForTask({
        task: WORKLOAD.contextTasks[index % WORKLOAD.contextTasks.length],
        includeArchived: false,
      });
      contextSamples.push(performance.now() - started);
    }
    if (firstTable !== undefined) {
      for (let index = 0; index < TABLE_ITERATIONS; index += 1) {
        const started = performance.now();
        await runtime.queryTable({
          tableId: firstTable.tableId,
          sql: WORKLOAD.tableQuery.replace('<described-sql-name>', firstTable.sqlName),
          limit: 100,
        });
        tableSamples.push(performance.now() - started);
      }
    }
    backend.close();

    return {
      tier: name,
      packs,
      corpus: {
        artifacts: lastBuild.counts.artifacts,
        bytes: lastProjectBytes,
        nodes: lastBuild.counts.nodes,
        chunks: lastBuild.counts.chunks,
        tables: lastBuild.counts.tables,
        tableRows: lastBuild.counts.tableRows,
      },
      peakRssMiB: Math.round((peakRssBytes() / 1024 ** 2) * 100) / 100,
      measurements: {
        buildMs: {
          p50: percentile(buildSamples, 0.5),
          p95: percentile(buildSamples, 0.95),
          samples: SAMPLES,
        },
        incrementalMs: {
          p50: percentile(incrementalSamples, 0.5),
          p95: percentile(incrementalSamples, 0.95),
          samples: SAMPLES,
        },
        incrementalReusedArtifacts: {
          min: Math.min(...incrementalReused),
          max: Math.max(...incrementalReused),
        },
        warmSearchMs: {
          p50: percentile(querySamples, 0.5),
          p95: percentile(querySamples, 0.95),
          samples: QUERY_ITERATIONS,
        },
        contextBundleMs: {
          p50: percentile(contextSamples, 0.5),
          p95: percentile(contextSamples, 0.95),
          samples: CONTEXT_ITERATIONS,
        },
        tableQueryMs: {
          p50: percentile(tableSamples, 0.5),
          p95: percentile(tableSamples, 0.95),
          samples: tableSamples.length,
        },
      },
    };
  } finally {
    if (lastRoot !== undefined) rmSync(lastRoot, { recursive: true, force: true });
  }
}

export { buildAt, MANIFEST, WORKLOAD, writeProject };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const artifact of MANIFEST.artifacts) {
    const path = join(REPO, artifact.path);
    if (sha256(path) !== artifact.sha256)
      throw new Error(`Corpus checksum mismatch: ${artifact.path}`);
    if (statSync(path).size !== artifact.bytes)
      throw new Error(`Corpus byte count mismatch: ${artifact.path}`);
  }

  const results = [];
  for (const tier of tiers) results.push(await measureTier(tier));

  const report = {
    provisional: true,
    reportedNotEnforced: true,
    generatedAt: '2026-10-04',
    corpusManifest: relative(REPO, MANIFEST_PATH),
    queryWorkload: 'benchmarks/corpus/queries.json',
    limitation:
      'The medium and large tiers repeat repository-owned mixed-format packs with deterministic path-local text. They establish scale trends and parser coverage, not a representative industry corpus. A public industry baseline remains issue 386.',
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      node: process.versions.node,
    },
    samples: {
      build: SAMPLES,
      incremental: SAMPLES,
      warmSearch: QUERY_ITERATIONS,
      contextBundle: CONTEXT_ITERATIONS,
      tableQuery: TABLE_ITERATIONS,
    },
    tiers: results,
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputIndex = process.argv.indexOf('--out');
  if (outputIndex !== -1 && process.argv[outputIndex + 1] !== undefined) {
    const output = process.argv[outputIndex + 1];
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, serialized, 'utf8');
    console.log(`Wrote ${output}`);
  }
  console.log(serialized);
}
