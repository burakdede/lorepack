#!/usr/bin/env node
/**
 * Run the opt-in RAG baseline. Offline mode is safe for CI and contributors without
 * provider credentials. Hosted mode uses an OpenAI-compatible endpoint only when explicitly
 * selected with RAG_BENCH_MODE=hosted.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildAt, WORKLOAD, writeProject } from './bench-corpus.mjs';
import { validateBenchmarkReport } from './benchmark-report.mjs';

const REPO = join(import.meta.dirname, '..');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function outputPath() {
  const index = process.argv.indexOf('--out');
  return index === -1 ? undefined : process.argv[index + 1];
}

const project = writeProject(40);
try {
  const built = await buildAt(project.root);
  const buildDatabasePath = join(project.root, '.lore', 'builds', built.buildId, 'context.sqlite');
  const metadata = {
    mode: process.env.RAG_BENCH_MODE ?? 'offline',
    runner: process.env.RUNNER_NAME ?? process.env.GITHUB_JOB ?? 'local',
    storageClass: process.env.LORE_BENCH_STORAGE_CLASS ?? 'unknown',
    commitSha:
      process.env.GITHUB_SHA ??
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
    corpus: {
      manifestPath: 'benchmarks/corpus/manifest.json',
      manifestSha256: sha256(join(REPO, 'benchmarks/corpus/manifest.json')),
      scale: 'large',
      profile: 'mixed',
      artifacts: built.counts.artifacts,
      bytes: project.bytes,
      chunks: built.counts.chunks,
      tables: built.counts.tables,
    },
    workload: {
      path: 'benchmarks/corpus/queries.json',
      sha256: sha256(join(REPO, 'benchmarks/corpus/queries.json')),
      queryCount: WORKLOAD.searchQueries.length,
      contextTaskCount: WORKLOAD.contextTasks.length,
      tableQueryCount: 1,
    },
  };
  const worker = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, 'bench-rag-baseline-worker.mjs'),
      buildDatabasePath,
      JSON.stringify(metadata),
    ],
    { cwd: REPO, encoding: 'utf8', env: process.env },
  );
  if (worker.status !== 0) throw new Error(`RAG baseline failed: ${worker.stderr}`);
  const report = JSON.parse(worker.stdout.trim());
  const problems = validateBenchmarkReport(report);
  if (problems.length > 0)
    throw new Error(`RAG report failed protocol validation:\n${problems.join('\n')}`);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const output = outputPath();
  if (output !== undefined) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, serialized, 'utf8');
    console.error(`Wrote ${output}`);
  }
  process.stdout.write(serialized);
} finally {
  rmSync(project.root, { recursive: true, force: true });
}
