#!/usr/bin/env node
/**
 * The Phase 1 benchmark suite: full build, incremental rebuild, warm search.
 *
 * Results are **reported, not enforced**. Architecture section 5.5 states the gates
 * against a reference machine, and that machine is defined in backlog issue #101 (Phase 7).
 * Every result here is therefore labelled provisional and carries the machine that
 * produced it, because a performance number without its machine is not a measurement.
 *
 *   node scripts/bench.mjs [--out benchmarks/local.json]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { runBuild } from '../packages/cli/dist/services/build.js';
import { runSearch } from '../packages/cli/dist/services/search.js';
import { loadConfig, ProgressBus } from '../packages/core/dist/index.js';

const DOCUMENTS = 60;
const PAGES = 10;
const SEARCH_ITERATIONS = 50;

function page(seed, index) {
  const paragraphs = [];
  for (let i = 0; i < 6; i += 1) {
    paragraphs.push(
      `Paragraph ${i} of section ${index} in document ${seed}, describing deployment, ` +
        'rollback, retention and the constraints that apply, at roughly the length of a ' +
        'real page of documentation rather than a stub.',
    );
  }
  return `## Section ${index} of ${seed}\n\n${paragraphs.join('\n\n')}`;
}

function document(seed) {
  const sections = [];
  for (let index = 0; index < PAGES; index += 1) sections.push(page(seed, index));
  return `# Document ${seed}\n\n${sections.join('\n\n')}\n`;
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return Math.round((sorted[position] ?? 0) * 100) / 100;
}

const root = mkdtempSync(join(tmpdir(), 'lorepack-bench-'));
try {
  writeFileSync(join(root, 'lore.yaml'), 'version: 1\nname: bench\nsources:\n  - .\n', 'utf8');
  for (let index = 0; index < DOCUMENTS; index += 1) {
    writeFileSync(join(root, `doc-${index}.md`), document(index), 'utf8');
  }

  const build = () => runBuild({ config: loadConfig({ cwd: root }), progress: new ProgressBus() });

  const coldStart = performance.now();
  const cold = await build();
  const coldMs = performance.now() - coldStart;

  writeFileSync(join(root, 'doc-0.md'), document('0-edited'), 'utf8');
  const warmStart = performance.now();
  const incremental = await build();
  const incrementalMs = performance.now() - warmStart;

  // Warm search: the first call pays for opening the database, so it is measured
  // separately from the steady-state samples rather than averaged into them.
  const config = loadConfig({ cwd: root });
  const firstSearchStart = performance.now();
  await runSearch({ config, query: 'rollback retention', sourceState: 'clean' });
  const coldSearchMs = performance.now() - firstSearchStart;

  const searchSamples = [];
  for (let index = 0; index < SEARCH_ITERATIONS; index += 1) {
    const started = performance.now();
    await runSearch({ config, query: 'rollback retention', sourceState: 'clean' });
    searchSamples.push(performance.now() - started);
  }

  const report = {
    provisional: true,
    reason:
      'Measured on the development machine. The reference machine and the gates are backlog issue #101.',
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
      pagesEach: PAGES,
      artifacts: cold.counts.artifacts,
      chunks: cold.counts.chunks,
    },
    measurements: {
      fullBuildMs: Math.round(coldMs),
      incrementalBuildMs: Math.round(incrementalMs),
      incrementalReusedArtifacts: incremental.reusedArtifacts,
      incrementalRebuiltArtifacts: incremental.rebuiltArtifacts,
      coldSearchMs: Math.round(coldSearchMs * 100) / 100,
      warmSearchP50Ms: percentile(searchSamples, 0.5),
      warmSearchP95Ms: percentile(searchSamples, 0.95),
      searchIterations: SEARCH_ITERATIONS,
    },
    // Stated so a reader can see the distance to the gate without looking it up, and so a
    // regression is visible even while the numbers are provisional.
    referenceGates: { incrementalBuildMs: 2000, warmSearchP95Ms: 300 },
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
