#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { validateBenchmarkReport } from './benchmark-report.mjs';

const directory = process.argv[2];
if (directory === undefined) {
  console.error('Usage: node scripts/check-benchmark-artifacts.mjs <directory> [--summary <path>]');
  process.exit(2);
}

function jsonFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    if (entry.isDirectory()) return jsonFiles(root, path);
    return entry.name.endsWith('.json') ? [path] : [];
  });
}

function fail(message) {
  throw new Error(message);
}

function checkProtocol(report, label) {
  const problems = validateBenchmarkReport(report);
  if (problems.length > 0) fail(`${label}:\n${problems.join('\n')}`);
}

function collectReports(files) {
  const reports = [];
  for (const path of files) {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    if (report.protocol?.name === 'lorepack-benchmark') {
      checkProtocol(report, relative(directory, path));
      reports.push({ path, report });
      continue;
    }
    if (report.protocol?.name === 'lorepack-benchmark-comparison') {
      for (const [name, nested] of Object.entries(report.protocolReports ?? {})) {
        checkProtocol(nested, `${relative(directory, path)}.${name}`);
        reports.push({ path: `${path}.${name}`, report: nested });
      }
      continue;
    }
    if (report.protocol?.name === 'lorepack-usefulness-metrics') {
      if (report.protocol.version !== 1)
        fail(`${relative(directory, path)} has an unknown protocol version`);
      const metrics = report.metrics;
      if (metrics?.rollback?.restored !== true || metrics?.rollback?.rebuildAvoided !== true)
        fail(`${relative(directory, path)} does not prove rollback recovery and rebuild avoidance`);
      continue;
    }
    if (report.protocol?.name === 'lorepack-benchmark-evidence') {
      if (report.protocol.version !== 1)
        fail(`${relative(directory, path)} has an unknown evidence protocol version`);
      continue;
    }
    if (report.protocol?.name === 'lorepack-research-pruning') {
      if (report.protocol.version !== 1)
        fail(`${relative(directory, path)} has an unknown pruning protocol version`);
      if (report.quality?.exactTopK?.denominator === undefined)
        fail(`${relative(directory, path)} has no exact top-k result denominator`);
      continue;
    }
    fail(`${relative(directory, path)} is not a supported benchmark artifact`);
  }
  return reports;
}

const files = jsonFiles(directory);
if (files.length === 0) fail(`${directory} contains no JSON benchmark artifacts`);
const reports = collectReports(files);
if (reports.length === 0) fail('No protocol v1 implementation reports were found');
const identities = new Set(
  reports.map(({ report }) =>
    JSON.stringify({
      commitSha: report.commitSha,
      manifestSha256: report.corpus.manifestSha256,
      workloadSha256: report.workload.sha256,
      scale: report.corpus.scale,
      profile: report.corpus.profile,
    }),
  ),
);
if (identities.size !== 1)
  fail(
    'Implementation reports do not share one commit, corpus, workload, platform, runner and profile identity',
  );

const lines = [
  '# Benchmark evidence summary',
  '',
  'Rows remain separate by implementation and runner identity. No unlike machines were averaged.',
  '',
  '| Artifact | Implementation | Scale | Warm p95 (ms) | Context p95 (ms) | Token status |',
  '|---|---|---|---:|---:|---|',
];
for (const { path, report } of reports) {
  const phase = (name) => report.measurements.phases.find((entry) => entry.name === name)?.p95Ms;
  lines.push(
    `| ${relative(directory, path)} | ${report.implementation.name} | ${report.corpus.scale} | ${phase('warm-query') ?? 'n/a'} | ${phase('context-assembly') ?? 'n/a'} | ${report.tokenAccounting.status} |`,
  );
}
lines.push(
  '',
  `Validated ${reports.length} implementation reports from ${files.length} JSON artifacts.`,
);
const summaryIndex = process.argv.indexOf('--summary');
if (summaryIndex !== -1 && process.argv[summaryIndex + 1] !== undefined) {
  writeFileSync(process.argv[summaryIndex + 1], `${lines.join('\n')}\n`, 'utf8');
}
console.log(lines.join('\n'));
