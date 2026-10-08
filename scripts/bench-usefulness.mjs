#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createLocalRuntimeBackend,
  LocalStateStore,
  stateMigrationsDirectory,
} from '../packages/backend-local/dist/index.js';
import { createRuntime } from '../packages/runtime/dist/index.js';
import { buildAt, WORKLOAD, writeProject } from './bench-corpus.mjs';
import { matchesLocation } from './bench-quality.mjs';
import {
  changeReviewWorkload,
  contextBudgetFit,
  expectedLocationCoverage,
  provenanceCoverage,
  rollbackEvidence,
} from './benchmark-metrics.mjs';

const REPO = join(import.meta.dirname, '..');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function outputPath() {
  const index = process.argv.indexOf('--out');
  return index === -1 ? undefined : process.argv[index + 1];
}

const project = writeProject(1);
let state;
try {
  const first = await buildAt(project.root);
  const backend = createLocalRuntimeBackend({ projectRoot: project.root });
  const runtime = createRuntime(backend);
  const searchLocators = [];
  const contextLocators = [];
  const contextBundles = [];
  let contextExpectedLocations = 0;
  let citedLocations = 0;
  let searchCases = 0;
  let searchHitAt1 = 0;
  let searchHitAt5 = 0;

  for (const entry of WORKLOAD.qualityQueries) {
    if (entry.kind === 'search') {
      const result = await runtime.search({ query: entry.query, limit: 5, includeArchived: false });
      searchCases += 1;
      searchLocators.push(...result.hits.map((hit) => hit.locator));
      if (
        entry.expected.some((expected) =>
          result.hits.slice(0, 1).some((hit) => matchesLocation(hit.locator, expected)),
        )
      )
        searchHitAt1 += 1;
      if (
        entry.expected.some((expected) =>
          result.hits.some((hit) => matchesLocation(hit.locator, expected)),
        )
      )
        searchHitAt5 += 1;
    } else {
      contextExpectedLocations += entry.expected.length;
      const bundle = await runtime.contextForTask({ task: entry.query, includeArchived: false });
      contextBundles.push(bundle);
      contextLocators.push(...bundle.citations);
      citedLocations += entry.expected.filter((expected) =>
        bundle.citations.some((citation) => matchesLocation(citation, expected)),
      ).length;
    }
  }

  const tables = await runtime.listTables();
  const tableDescription =
    tables[0] === undefined ? null : await runtime.describeTable(tables[0].tableId);
  const tableResult =
    tableDescription === null
      ? null
      : await runtime.queryTable({
          tableId: tableDescription.tableId,
          sql: `SELECT * FROM ${tableDescription.sqlName}`,
          limit: 100,
        });
  const tableLocators =
    tableResult === null
      ? []
      : Array.from({ length: tableResult.rowCount }, () => tableResult.locator);
  backend.close();

  const editedPath = join(project.root, 'sources', 'pack-000', '000-product-strategy.md');
  const beforeContents = readFileSync(editedPath, 'utf8');
  writeFileSync(editedPath, `${beforeContents}\nMetric fixture edit.\n`, 'utf8');
  const second = await buildAt(project.root);

  state = LocalStateStore.open(join(project.root, '.lore'), stateMigrationsDirectory());
  const rollbackStarted = performance.now();
  state.activate(first.buildId);
  const rollbackMs = performance.now() - rollbackStarted;
  const current = state.current();

  const report = {
    protocol: { name: 'lorepack-usefulness-metrics', version: 1 },
    generatedAt: new Date().toISOString(),
    commitSha:
      process.env.GITHUB_SHA ??
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
    machine: { platform: process.platform, arch: process.arch, node: process.versions.node },
    corpus: {
      manifestPath: 'benchmarks/corpus/manifest.json',
      manifestSha256: sha256(join(REPO, 'benchmarks/corpus/manifest.json')),
      scale: 'small',
      artifacts: first.counts.artifacts,
      chunks: first.counts.chunks,
      tables: first.counts.tables,
    },
    definitions: {
      provenance: 'valid SourceLocator-bearing outputs divided by all outputs on each surface',
      expectedLocation: 'expected labelled locations cited divided by expected labelled locations',
      contextBudget: 'bundles within their declared budget, plus every omitted item and reason',
      changeReview: 'added, changed and removed source artifacts, warnings and context delta',
      rollback: 'pointer-change latency, active-build restoration and rebuilds performed',
    },
    metrics: {
      provenance: {
        search: provenanceCoverage(searchLocators),
        context: provenanceCoverage(contextLocators),
        tableRows: provenanceCoverage(tableLocators),
      },
      retrieval: {
        cases: searchCases,
        hitAt1: expectedLocationCoverage(searchHitAt1, searchCases),
        hitAt5: expectedLocationCoverage(searchHitAt5, searchCases),
      },
      expectedLocation: expectedLocationCoverage(citedLocations, contextExpectedLocations),
      contextBudget: contextBudgetFit(contextBundles),
      changeReview: changeReviewWorkload({
        added: 0,
        changed: 1,
        removed: 0,
        warnings: second.warnings,
        contextDelta: second.counts.chunks - first.counts.chunks,
      }),
      rollback: rollbackEvidence({
        pointerChangeMs: Math.round(rollbackMs * 100) / 100,
        activeBuildId: current?.buildId ?? null,
        expectedBuildId: first.buildId,
        rebuiltBuilds: 0,
      }),
      buildReuse: {
        firstBuildMs: first.durationMs,
        secondBuildMs: second.durationMs,
        reusedArtifacts: second.reusedArtifacts,
        rebuiltArtifacts: second.rebuiltArtifacts,
      },
    },
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const output = outputPath();
  if (output !== undefined) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, serialized, 'utf8');
    console.error(`Wrote ${output}`);
  }
  process.stdout.write(serialized);
} finally {
  state?.close();
  rmSync(project.root, { recursive: true, force: true });
}
